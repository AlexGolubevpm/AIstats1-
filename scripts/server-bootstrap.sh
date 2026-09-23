#!/usr/bin/env bash
# One-time bootstrap of a fresh Timeweb VPS (Ubuntu 22.04/24.04) for TubeStat.
# Run as root:  sudo bash server-bootstrap.sh "<deploy public key>"
#
# What it does: updates packages, adds swap, firewall + fail2ban, installs Docker,
# creates the `deploy` user that GitHub Actions logs in as, prepares /opt/tubestat,
# disables SSH password login (only if a key is already installed for root).
set -euo pipefail

DEPLOY_PUBKEY="${1:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash $0 \"<deploy public key>\")" >&2
  exit 1
fi
if [ -z "$DEPLOY_PUBKEY" ]; then
  echo "Pass the public half of the GitHub Actions deploy key as the first argument." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl ca-certificates ufw fail2ban unattended-upgrades jq

echo "==> Swap (4G, skipped if swap already exists)"
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
  sysctl -p /etc/sysctl.d/99-swappiness.conf
fi

echo "==> Firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban

echo "==> Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> deploy user"
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$DEPLOY_PUBKEY" /home/deploy/.ssh/authorized_keys || echo "$DEPLOY_PUBKEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

echo "==> App directory"
install -d -m 750 -o deploy -g deploy /opt/tubestat /opt/tubestat/backups
if [ ! -f /opt/tubestat/.env ]; then
  install -m 600 -o deploy -g deploy /dev/null /opt/tubestat/.env
fi

echo "==> SSH hardening"
if [ -s /root/.ssh/authorized_keys ]; then
  cat > /etc/ssh/sshd_config.d/99-tubestat.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  echo "    Password login disabled."
else
  echo "    WARNING: root has no SSH key in /root/.ssh/authorized_keys — password login left ON."
  echo "    Add your own key, then re-run this script to disable passwords."
fi

IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
cat <<EOF

Done. Server IP: $IP
Next: fill /opt/tubestat/.env (see .env.example in the repo) and add GitHub secrets — docs/CICD.md
EOF
