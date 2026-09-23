#!/usr/bin/env bash
# Fails if any relative Markdown link in the repo points to a missing file.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 - <<'PY'
import glob, os, re, sys
files = glob.glob("docs/**/*.md", recursive=True) + glob.glob("*.md") + glob.glob(".github/*.md")
bad = []
for f in files:
    text = open(f, encoding="utf-8").read()
    for m in re.finditer(r"\]\(([^)#\s]+)(#[^)]*)?\)", text):
        target = m.group(1)
        if re.match(r"^[a-z]+:", target):
            continue
        path = os.path.normpath(os.path.join(os.path.dirname(f), target))
        if not os.path.exists(path):
            bad.append(f"{f}: {target}")
for b in bad:
    print("FAIL broken link", b)
print(f"checked {len(files)} files, {len(bad)} broken links")
sys.exit(1 if bad else 0)
PY
