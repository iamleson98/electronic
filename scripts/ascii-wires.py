"""Pixel-level wire detector: finds wire stroke color pixels in a
screenshot region and prints an ASCII map so diagonals are visible."""
import sys
from PIL import Image

def near_any(p, targets, tol=45):
    return any(all(abs(p[i] - t[i]) <= tol for i in range(3)) for t in targets)

def ascii_map(src, box, step=2, targets=((34, 211, 238), (71, 85, 105), (239, 68, 68))):
    img = Image.open(src).convert('RGB')
    region = img.crop(box)
    w, h = region.size
    px = region.load()
    out = []
    for y in range(0, h, step):
        row = ''
        for x in range(0, w, step):
            row += '#' if near_any(px[x, y], targets) else '.'
        out.append(row)
    return out

if __name__ == '__main__':
    src = sys.argv[1]
    l, t, r, b = map(int, sys.argv[2:6])
    step = int(sys.argv[6]) if len(sys.argv) > 6 else 2
    rows = ascii_map(src, (l, t, r, b), step=step)
    print(f"region ({l},{t})-({r},{b}) step={step}  (each char = {step}px)")
    for i, row in enumerate(rows):
        print(f"{t + i*step:4d} {row}")
