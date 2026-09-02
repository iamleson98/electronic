#!/bin/bash
# Sweep all 26 examples: open Examples menu (click @e17), click item N, screenshot.
set -u
OUT=/home/z/my-project/shots/sweep
mkdir -p "$OUT"

for i in $(seq 1 26); do
  agent-browser click @e17 >/dev/null 2>&1
  sleep 0.5
  agent-browser snapshot -i --json > /tmp/menu.json 2>/dev/null
  REF=$(python3 - "$i" <<'EOF'
import json, sys
want = int(sys.argv[1])
try:
    d = json.load(open('/tmp/menu.json'))
except Exception:
    print(''); raise SystemExit
refs = (d.get('data') or {}).get('refs') or {}
items = [(ref, info) for ref, info in refs.items() if info.get('role') == 'menuitem']
def num(r):
    try: return int(r.lstrip('e'))
    except Exception: return 9999
items.sort(key=lambda kv: num(kv[0]))
if want <= len(items):
    print(items[want-1][0])
EOF
)
  if [ -z "${REF:-}" ]; then
    echo "item $i: REF NOT FOUND"
    continue
  fi
  agent-browser click "$REF" >/dev/null 2>&1
  sleep 1.5
  agent-browser screenshot "$OUT/ex-$(printf '%02d' $i).png" >/dev/null 2>&1
  echo "item $i: $REF"
done
