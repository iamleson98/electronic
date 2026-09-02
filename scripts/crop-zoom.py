#!/usr/bin/env python3
"""Crop and upscale regions of a screenshot for close inspection."""
import sys
from PIL import Image

def crop_zoom(src, dst, box, scale=3):
    img = Image.open(src)
    region = img.crop(box)  # (left, top, right, bottom)
    w, h = region.size
    region = region.resize((w * scale, h * scale), Image.LANCZOS)
    region.save(dst)
    print(f"saved {dst} ({w}x{h} -> {w*scale}x{h*scale})")

if __name__ == "__main__":
    src = sys.argv[1]
    dst = sys.argv[2]
    left, top, right, bottom = map(int, sys.argv[3:7])
    scale = int(sys.argv[7]) if len(sys.argv) > 7 else 3
    crop_zoom(src, dst, (left, top, right, bottom), scale)
