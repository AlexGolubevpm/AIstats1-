#!/usr/bin/env bash
# deploy/prune-images.sh with a fake `docker`: keeps the last 3 deployed app tags, removes the rest
# of the app repository only, never touches other images, and survives a failing docker.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
case "$1" in
  images) cat "$FAKE/images" ;;
  rmi) echo "$2" >> "$FAKE/removed"; grep -vxF "$2" "$FAKE/images" > "$FAKE/i.tmp" || true; mv "$FAKE/i.tmp" "$FAKE/images" ;;
  image) echo prune >> "$FAKE/calls" ;;
esac
SH
chmod +x "$tmp/bin/docker"
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
R=ghcr.io/x/tubestat
run() { FAKE="$tmp" PATH="$tmp/bin:$PATH" TUBESTAT_DIR="$tmp" bash deploy/prune-images.sh "$1"; }

printf '%s\n' $R:a $R:b $R:c $R:d $R:e "$R:<none>" > "$tmp/images"
printf '%s\n' $R:a $R:b $R:c $R:d > "$tmp/.image-history"
out=$(run $R:e)
check "history keeps the last 3"      '[ "$(cat "$tmp/.image-history")" = "$(printf "%s\n" $R:c $R:d $R:e)" ]'
check "older tags removed"            '[ "$(sort "$tmp/removed")" = "$(printf "%s\n" $R:a $R:b)" ]'
check "kept tags still there"         'grep -qxF $R:c "$tmp/images" && grep -qxF $R:e "$tmp/images"'
check "dangling layers pruned"        'grep -q prune "$tmp/calls"'
check "reports counts"                '[ "$out" = "images: kept 3, removed 2" ]'

: > "$tmp/removed"
run $R:d >/dev/null
check "redeploy moves tag to the end" '[ "$(cat "$tmp/.image-history")" = "$(printf "%s\n" $R:c $R:e $R:d)" ]'
check "nothing else removed"          '[ ! -s "$tmp/removed" ]'

rm -f "$tmp/.image-history"; : > "$tmp/removed"; printf '%s\n' $R:new $R:p2 $R:p3 $R:p4 > "$tmp/images" # newest first, like docker
run $R:new >/dev/null
check "first run seeds from newest"   '[ "$(cat "$tmp/.image-history")" = "$(printf "%s\n" $R:p3 $R:p2 $R:new)" ]'
check "first run keeps 3 newest"      'grep -qxF $R:p2 "$tmp/images" && grep -qxF $R:p3 "$tmp/images" && [ "$(cat "$tmp/removed")" = "$R:p4" ]'

printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/docker"
check "failing docker does not fail"  'run $R:g >/dev/null'
exit $fail
