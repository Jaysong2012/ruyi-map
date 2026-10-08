#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""render_core/python/frame_qa.py — 黑带(letterbox/pillarbox)均匀度扫描硬闸

x264 黑电平在 16-32 之间，亮度阈值测不出黑带；正解=std 均匀度（黑带 std≈0，内容 std>2）。
用法: python3 frame_qa.py <video|image> [--times t1,t2,...] [--band 400] [--thr 2.0]
默认抽 5 个均布时刻；右带=右 band px，下带=下 band px（--sides 可选 left,top）。
"""
import argparse, subprocess, sys, tempfile, os
import numpy as np
from PIL import Image


def probe_dur(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                 "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())


def frame_at(video, t, out):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(t), "-i", video,
                    "-frames:v", "1", out], check=True)


def scan(img_path, band, thr=None):
    g = np.asarray(Image.open(img_path).convert("L")).astype(np.float32)
    h, w = g.shape
    return {"right": g[:, w - band:].std(), "bottom": g[h - band:, :].std(),
            "left": g[:, :band].std(), "top": g[:band, :].std(), "size": (w, h)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--times", default=None)
    ap.add_argument("--band", type=int, default=400)
    ap.add_argument("--thr", type=float, default=2.0)
    ap.add_argument("--sides", default="right,bottom")
    args = ap.parse_args()
    sides = args.sides.split(",")
    fails = []
    if args.src.lower().endswith((".png", ".jpg", ".jpeg")):
        checks, tmp = [("img", args.src)], None
    else:
        dur = probe_dur(args.src)
        times = [float(x) for x in args.times.split(",")] if args.times else \
            [round(dur * f, 1) for f in (0.05, 0.3, 0.5, 0.75, 0.95)]
        tmp = tempfile.mkdtemp()
        checks = []
        for t in times:
            p = os.path.join(tmp, f"f{t}.png")
            frame_at(args.src, t, p)
            checks.append((f"t={t}", p))
    for tag, p in checks:
        r = scan(p, args.band)
        line = f"  {tag:>8} " + " ".join(f"{s}={r[s]:6.2f}" for s in sides)
        bad = [s for s in sides if r[s] < args.thr]
        if bad:
            fails.append(f"{tag} 黑带检出: {bad} (std<{args.thr}, size={r['size']})")
            print(line, " ← 黑带!")
        else:
            print(line)
    if fails:
        print("FAIL", *fails, sep="\n  ")
        sys.exit(1)
    print(f"PASS letterbox scan ({len(checks)} 帧, band={args.band}px, thr={args.thr})")


if __name__ == "__main__":
    main()
