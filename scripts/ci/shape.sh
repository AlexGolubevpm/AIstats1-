#!/usr/bin/env bash
# Masks a string down to its shape so it can be printed in public CI logs:
# lowercase letters -> a, uppercase -> A, digits -> 9 (incl. non-ASCII letters -> a),
# punctuation and spaces are kept. "137648. japan-tube.com" -> "999999. aaaaa-aaaa.aaa".
# Reads stdin line by line, output is capped at 80 characters per line.
set -euo pipefail
python3 -c '
import sys
for line in sys.stdin:
    out = []
    for ch in line.rstrip("\n"):
        if ch.isdigit(): out.append("9")
        elif ch.isalpha(): out.append("A" if ch.isupper() else "a")
        else: out.append(ch)
    print("".join(out)[:80])
'
