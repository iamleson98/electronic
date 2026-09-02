#!/usr/bin/env python3
"""Measure edge anti-aliasing quality: scan for dark→green board transitions
and count intermediate shades (MSAA 4x → several partial-coverage colors;
no AA → a single hard 2-color step)."""
from PIL import Image
import sys

img = Image.open(sys.argv[1] if len(sys.argv) > 1 else '/home/z/my-project/download/shots/wc3d-v4-led.png').convert('RGB')
w, h = img.size
px = img.load()

def is_bg(c):
    r, g, b = c
    return r < 30 and g < 45 and b < 70  # dark studio background

def is_board(c):
    r, g, b = c
    return g > 60 and g > r * 1.6 and b < 120  # green mask

# scan every 4th row; find bg→board transitions; measure run length of
# "intermediate" pixels (neither bg nor board)
stats = []
for y in range(0, h, 4):
    x = 1
    while x < w - 1:
        if is_bg(px[x, y]) and not is_bg(px[x + 1, y]):
            # transition starts — walk while not clearly board
            run = 0
            xx = x + 1
            while xx < w - 1 and not is_board(px[xx, y]) and run < 12:
                run += 1
                xx += 1
            if run < 12 and xx < w - 1:  # ended in board → real edge
                stats.append(run)
            x = xx
        else:
            x += 1

if not stats:
    print('no bg->board edges found')
else:
    from collections import Counter
    c = Counter(stats)
    hard = sum(v for k, v in c.items() if k <= 0)
    one = c.get(1, 0)
    two_plus = sum(v for k, v in c.items() if k >= 2)
    total = len(stats)
    print(f'edges found: {total}')
    print(f'run-length histogram: {dict(sorted(c.items()))}')
    print(f'hard 1px steps: {one}/{total} ({100*one/total:.0f}%)  soft >=2px: {two_plus}/{total} ({100*two_plus/total:.0f}%)')
    avg = sum(stats) / total
    print(f'average transition width: {avg:.2f} px  (MSAA4x typically ~1.5-2.5)')
