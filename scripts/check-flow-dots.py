"""Check that amber current-flow dots lie ON the wire strokes.
Amber dots: #fde047 with shadow glow. Wire colors: cyan/slate/red.
A dot is 'on-wire' when a wire-colored pixel exists within R px of it."""
import sys
from PIL import Image

DOT = (253, 224, 71)      # #fde047
WIRES = ((34, 211, 238), (71, 85, 105), (239, 68, 68))
TOL = 60

def near(p, t, tol):
    return all(abs(p[i] - t[i]) <= tol for i in range(3))

def main(src, radius=4):
    img = Image.open(src).convert('RGB')
    w, h = img.size
    px = img.load()
    dots = []
    wire = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if near(p, DOT, TOL):
                dots.append((x, y))
            elif any(near(p, t, TOL) for t in WIRES):
                wire[y][x] = True
    if not dots:
        print(f"{src}: no amber dots found")
        return
    off = []
    for (x, y) in dots:
        found = False
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and wire[ny][nx]:
                    found = True
                    break
            if found:
                break
        if not found:
            off.append((x, y))
    print(f"{src}: {len(dots)} dot pixels, {len(off)} OFF-wire pixels ({100*len(off)/max(1,len(dots)):.1f}%)")
    # cluster off pixels
    if off:
        seen = set()
        clusters = []
        for p in off:
            if p in seen: continue
            stack = [p]; seen.add(p); pts = []
            while stack:
                c = stack.pop(); pts.append(c)
                for dy in (-3,-2,-1,0,1,2,3):
                    for dx in (-3,-2,-1,0,1,2,3):
                        q = (c[0]+dx, c[1]+dy)
                        if q in off and q not in seen:
                            seen.add(q); stack.append(q)
            clusters.append(pts)
        clusters.sort(key=lambda c: -len(c))
        for c in clusters[:12]:
            xs = [p[0] for p in c]; ys = [p[1] for p in c]
            print(f"  OFF-wire dot cluster at x[{min(xs)}..{max(xs)}] y[{min(ys)}..{max(ys)}] size={len(c)}")

if __name__ == '__main__':
    for src in sys.argv[1:]:
        main(src)
