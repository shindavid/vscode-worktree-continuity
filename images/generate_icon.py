#!/usr/bin/env python3
"""Generate images/icon.png — the marketplace icon for Worktree Continuity.

A flat, two-tone geometric placeholder: a rounded dark tile with a git-worktree
motif — a trunk that forks into two parallel branch lanes, with commit dots.
No text. Regenerate with:  python3 images/generate_icon.py

Requires Pillow (PIL). Renders at 4x and downsamples for clean anti-aliasing.
"""
import os
from PIL import Image, ImageDraw

S = 256          # output size (px); marketplace-friendly retina size
SS = 4           # supersample factor
W = S * SS

# Palette
BG = (24, 28, 35, 255)        # #181c23 dark slate
TRUNK = (86, 161, 90, 255)    # #56a15a medium green (tone A)
BRANCH = (137, 209, 133, 255) # #89d185 light green (tone B) — matches the
                              # extension's "current worktree" green
CORNER_R = 56                 # tile corner radius (in 256 space)
STROKE = 18                   # motif stroke width (in 256 space)


def k(v):
    """Scale a 256-space value into supersampled pixels."""
    return v * SS


def stroke(draw, p1, p2, width, color):
    """A thick line with round caps (circles at both endpoints)."""
    draw.line([k(p1[0]), k(p1[1]), k(p2[0]), k(p2[1])], fill=color, width=k(width))
    r = width / 2
    for (x, y) in (p1, p2):
        draw.ellipse([k(x - r), k(y - r), k(x + r), k(y + r)], fill=color)


def dot(draw, center, r, color):
    x, y = center
    draw.ellipse([k(x - r), k(y - r), k(x + r), k(y + r)], fill=color)


def main():
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded tile background.
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=k(CORNER_R), fill=BG)

    # Trunk (bottom → fork).
    stroke(d, (128, 208), (128, 140), STROKE, TRUNK)
    # Fork diagonals (trunk tone).
    stroke(d, (128, 140), (84, 104), STROKE, TRUNK)
    stroke(d, (128, 140), (172, 104), STROKE, TRUNK)
    # Two parallel branch lanes (branch tone).
    stroke(d, (84, 104), (84, 52), STROKE, BRANCH)
    stroke(d, (172, 104), (172, 52), STROKE, BRANCH)

    # Commit dots: trunk base + fork node (trunk tone), branch tips (branch tone).
    dot(d, (128, 208), 15, TRUNK)
    dot(d, (128, 140), 11, TRUNK)
    dot(d, (84, 52), 15, BRANCH)
    dot(d, (172, 52), 15, BRANCH)

    out = img.resize((S, S), Image.LANCZOS)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")
    out.save(path, "PNG")
    print(f"wrote {path} ({S}x{S})")


if __name__ == "__main__":
    main()
