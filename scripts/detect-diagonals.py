"""Detect diagonal line pixels in wire mask: a pixel is 'diagonal' when its
4-connected neighbors (up/down/left/right) are empty but diagonal neighbors
exist. Clusters of diagonal pixels = diagonal wire segments."""
import sys
from PIL import Image

TARGETS = ((34, 211, 238), (71, 85, 105), (239, 68, 68))
TOL = 45

def near_any(p):
    return any(all(abs(p[i] - t[i]) <= TOL for i in range(3)) for t in TARGETS)

def main(src):
    img = Image.open(src).convert('RGB')
    w, h = img.size
    px = img.load()
    mask = [[near_any(px[x, y]) for x in range(w)] for y in range(h)]

    # Diagonal candidates: 4-neighbors empty, has diagonal neighbor
    diag = [[False] * w for _ in range(h)]
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if not mask[y][x]:
                continue
            n4 = mask[y-1][x] or mask[y+1][x] or mask[y][x-1] or mask[y][x+1]
            if n4:
                continue  # part of an H/V thick line or junction
            nd = mask[y-1][x-1] or mask[y-1][x+1] or mask[y+1][x-1] or mask[y+1][x+1]
            if nd:
                diag[y][x] = True

    # Flood-fill cluster diagonal pixels
    seen = [[False] * w for _ in range(h)]
    clusters = []
    for y in range(h):
        for x in range(w):
            if diag[y][x] and not seen[y][x]:
                stack = [(x, y)]
                seen[y][x] = True
                pts = []
                while stack:
                    cx, cy = stack.pop()
                    pts.append((cx, cy))
                    for dy in (-2, -1, 0, 1, 2):
                        for dx in (-2, -1, 0, 1, 2):
                            nx, ny = cx + dx, cy + dy
                            if 0 <= nx < w and 0 <= ny < h and diag[ny][nx] and not seen[ny][nx]:
                                seen[ny][nx] = True
                                stack.append((nx, ny))
                if len(pts) >= 8:  # noise floor: < 8 px is AA/junction dot
                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    clusters.append({
                        'n': len(pts),
                        'x0': min(xs), 'x1': max(xs),
                        'y0': min(ys), 'y1': max(ys),
                    })
    clusters.sort(key=lambda c: -c['n'])
    print(f"{src}: {len(clusters)} diagonal clusters (>=8 px)")
    for c in clusters[:25]:
        dx = c['x1'] - c['x0']
        dy = c['y1'] - c['y0']
        print(f"  bbox x[{c['x0']}..{c['x1']}] y[{c['y0']}..{c['y1']}] size={c['n']}  dx={dx} dy={dy} slope={'45deg' if abs(dx - dy) < 4 else ('steep' if dy > dx else 'shallow')}")

if __name__ == '__main__':
    for src in sys.argv[1:]:
        main(src)
