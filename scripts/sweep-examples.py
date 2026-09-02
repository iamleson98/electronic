#!/usr/bin/env python3
"""Sweep all 26 examples: robustly locate the Examples dropdown by text each
time, click item N, screenshot each."""
import json
import re
import subprocess
import time
import sys

OUT = '/home/z/my-project/shots/sweep'

def run(args, **kw):
    return subprocess.run(['agent-browser', *args], capture_output=True, text=True, timeout=60, **kw)

def snapshot_plain():
    r = run(['snapshot', '-i'])
    return r.stdout

def find_examples_ref():
    out = snapshot_plain()
    for line in out.splitlines():
        if 'Examples' in line and 'ref=' in line and 'button' in line:
            m = re.search(r'ref=(e\d+)', line)
            if m:
                return m.group(1)
    return None

def menu_items():
    r = run(['snapshot', '-i', '--json'])
    try:
        d = json.loads(r.stdout)
    except Exception:
        return []
    refs = (d.get('data') or {}).get('refs') or {}
    items = [(ref, info) for ref, info in refs.items() if info.get('role') == 'menuitem']
    def num(r):
        try:
            return int(r.lstrip('e'))
        except Exception:
            return 99999
    items.sort(key=lambda kv: num(kv[0]))
    return items

def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 26
    for i in range(1, n + 1):
        # find and click Examples trigger
        ref = None
        for _ in range(3):
            ref = find_examples_ref()
            if ref:
                break
            time.sleep(0.5)
        if not ref:
            print(f'item {i}: trigger not found')
            continue
        run(['click', f'@{ref}'])
        time.sleep(0.6)
        items = menu_items()
        if not items:
            # menu was maybe already open and got toggled closed; retry
            ref2 = find_examples_ref()
            if ref2:
                run(['click', f'@{ref2}'])
                time.sleep(0.6)
                items = menu_items()
        if len(items) < i:
            print(f'item {i}: only {len(items)} items')
            continue
        mref, minfo = items[i - 1]
        run(['click', f'@{mref}'])
        time.sleep(1.6)
        shot = f'{OUT}/ex-{i:02d}.png'
        run(['screenshot', shot])
        print(f'item {i}: {mref} {minfo.get("name", "")[:38]}')

if __name__ == '__main__':
    main()
