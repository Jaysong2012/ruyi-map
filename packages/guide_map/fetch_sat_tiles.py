#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_sat_tiles.py — guide_map 瓦片缓存抓取器（管线最大缺口的补齐）

按 spec.bbox 抓 Esri World Imagery 瓦片到 <proj>/map/data/sat/<z>/<x>/<y>.jpg
（build_base.py 只读缓存不联网——抓取与渲染分离，断网可重跑渲染）。

用法:
  python3 packages/guide_map/fetch_sat_tiles.py <spec.json> [--zoom 14] [--pad 0]
  python3 packages/guide_map/fetch_sat_tiles.py <spec.json> --zoom 14 --dry   # 只打印瓦片清单与体积估计

海外源（AWS S3 / 部分地区的 Esri 节点）可能需自备代理：https_proxy 环境变量。
"""
import argparse, json, math, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
UA = {"User-Agent": "ruyi-map/0.1 (guide map tile fetcher)"}


def lonlat2xy(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(max(-85.05112878, min(85.05112878, lat)))
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return int(x), int(y)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--zoom", type=int, default=14)
    ap.add_argument("--pad", type=int, default=0, help="四周外扩瓦片数（取景余量）")
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    spec_path = Path(args.spec).resolve()
    spec = json.load(open(spec_path))
    proj = Path(spec.get("proj") or spec_path.parent)
    w, s, e, n = spec["bbox"]
    z = args.zoom
    x0, y1 = lonlat2xy(w, s, z)   # 西南角 → x 小 y 大
    x1, y0 = lonlat2xy(e, n, z)   # 东北角 → x 大 y 小
    x0, x1 = x0 - args.pad, x1 + args.pad
    y0, y1 = y0 - args.pad, y1 + args.pad
    tiles = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    out = proj / "map" / "data" / "sat" / str(z)
    print(f"bbox [{w},{s},{e},{n}] z{z} → x[{x0},{x1}] y[{y0},{y1}] 共 {len(tiles)} 瓦片 → {out}")
    if args.dry:
        print(f"体积估计 ≈ {len(tiles) * 45 / 1024:.0f} MB（均 45KB/片）")
        return
    out.mkdir(parents=True, exist_ok=True)

    def grab(t):
        x, y = t
        p = out / str(x) / f"{y}.jpg"
        if p.exists() and p.stat().st_size > 1024:
            return True
        p.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(SAT.format(z=z, x=x, y=y), headers=UA)
        for retry in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    p.write_bytes(r.read())
                return True
            except Exception as ex:
                if retry == 2:
                    print(f"  ✗ {x}/{y}: {ex}")
                    return False
        return False

    ok = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for i, good in enumerate(pool.map(grab, tiles)):
            ok += good
            if (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(tiles)} (ok {ok})")
    print(f"done {ok}/{len(tiles)}" + (" ✔" if ok == len(tiles) else " —— 有失败，重跑本命令可续抓"))
    sys.exit(0 if ok == len(tiles) else 1)


if __name__ == "__main__":
    main()
