#!/usr/bin/env python3
"""GIBS Himawari-9 红波段(1km)瓦片 → 西太马赛克（台风视觉层，公有领域，署名 JMA/NASA GIBS）。

用法:
  python3 scripts/himawari_mosaic.py <TIME_ISO8601> <out.jpg> [lon0 lat0 lon1 lat1]
  例: python3 scripts/himawari_mosaic.py 2026-08-27T12:50:00Z out.jpg 110 5 170 45

数据源: NASA GIBS WMTS 图层 Himawari_AHI_Band3_Red_Visible_1km（10min 一帧，
  归档自 2026-07-16，近实时）。国内直连快（~1.3s/瓦片），绕开 NOAA S3 原始 L1b
  的 13KB/s 慢速。时间序列：循环 TIME 即可拼旋转延时。
注意: 红波段为灰度+alpha（8-bit gray+alpha），做彩色需再叠 Band1/2 或上色。
"""
from __future__ import annotations
import io, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

DEG = 4.5            # Z6 每瓦片 4.5°
W = H = 512
UA = {'User-Agent': 'ruyi-map/0.1 (map baking tool)'}
BASE = ("https://gibs-a.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetTile"
        "&VERSION=1.0.0&LAYER=Himawari_AHI_Band3_Red_Visible_1km&STYLE=default&TILEMATRIXSET=1km"
        "&TILEMATRIX=6&FORMAT=image/png&TIME=")


def fetch(url: str):
    import time
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return Image.open(io.BytesIO(r.read())).convert('L')
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


def mosaic(time_iso: str, lon0: float, lat0: float, lon1: float, lat1: float) -> Image.Image:
    x0, x1 = int((lon0 + 180) // DEG), int((lon1 + 180) // DEG)
    y0, y1 = int((90 - lat1) // DEG), int((90 - lat0) // DEG)
    jobs = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    canvas = Image.new('L', ((x1 - x0 + 1) * W, (y1 - y0 + 1) * H), 0)
    missing = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for (x, y), tile in zip(jobs, ex.map(lambda xy: fetch(BASE + time_iso + f"&TILEROW={xy[1]}&TILECOL={xy[0]}"), jobs)):
            if tile is not None:
                canvas.paste(tile, ((x - x0) * W, (y - y0) * H))
            else:
                missing.append((x, y))
    if missing:
        # 缺瓦片=画面黑块，必须大声失败，不许静默出图（2026-08-27 tl.mp4 首帧黑块教训）
        sys.exit(f'[himawari_mosaic] MISSING {len(missing)} tiles at {time_iso}: {missing}')
    return canvas


if __name__ == '__main__':
    if len(sys.argv) < 3 or sys.argv[1] in ('-h', '--help'):
        print(__doc__.strip())
        sys.exit(0 if len(sys.argv) > 1 else 2)
    time_iso, out = sys.argv[1], sys.argv[2]
    bbox = [float(v) for v in sys.argv[3:7]] if len(sys.argv) > 3 else [110, 5, 170, 45]
    img = mosaic(time_iso, *bbox)
    # 可见光波段夜侧全黑：出图前做亮度 sanity check（2026-08-27 Saudel 1250Z 全黑事故）
    import statistics
    small = img.resize((64, 64))
    mean = statistics.mean(small.getdata())
    if mean < 8:
        print(f'[himawari_mosaic] WARNING mean luminance {mean:.1f}/255 — 目标区域大概率在夜侧，'
              f'可见光 Band3 夜间无信号，换白天时刻（当地正午≈该经度 12:00 地方时）', file=sys.stderr)
    img.save(out, quality=92)
    print(f'saved {out} {img.size} mean_lum={mean:.1f}')
