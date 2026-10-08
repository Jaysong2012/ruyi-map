#!/usr/bin/env python3
"""make_relief_tiles.py — DEM→分层设色地形瓦片仓级工具（EP6 川西 v2「地图是片子的灵魂」2026-09-17）

病根：卫星图底=海拔不可读（一片黑绿山疙瘩，主人判「一坨屎」）。
正解=自然地理课本式分层设色地形图：海拔色带（盆地绿→丘陵黄→高原褐→雪山白）
直接贴在 3D 地形上，平面视角也能一眼读出海拔；配合高 pitch 侧面视角=省级地形沙盘。

原理：遍历项目 data/dem/{z}/{x}/{y}.png（terrarium），解码海拔→色带映射→
写 data/relief/{z}/{x}/{y}.jpg。project.json 的 satellite.tiles 指到 relief 目录即完成换底
（渲染器零改动）。hillshade 层由渲染器按 dem 自动生成=晕渲免费。

用法: python3 packages/map-studio/tools/make_relief_tiles.py <project.json> [--zooms 8,9,10,11,12,13]

色带（四川 0-6000m 定标，低饱和高级灰方向）：
  <450   盆地  嫩绿 #7fb069 方向
  450-1200  丘陵  黄绿
  1200-2500 中山  黄褐
  2500-3500 高原  棕褐
  3500-4500 高高原 灰褐
  4500-5200 雪线  灰白
  >5200   雪山  白
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# (上限海拔 m, RGB) —— 低饱和分层设色（青灰盆地→褐金高原→雪白；v2 降饱和：盆地荧光绿判死）
RAMPS = [
    (0, (70, 104, 88)),
    (450, (128, 160, 112)),    # 盆地灰绿
    (800, (158, 172, 122)),    # 浅绿
    (1200, (188, 180, 132)),   # 黄绿
    (1800, (206, 180, 130)),   # 黄
    (2500, (202, 156, 114)),   # 黄褐
    (3200, (186, 136, 106)),   # 棕
    (4000, (166, 126, 110)),   # 棕褐
    (4600, (188, 172, 160)),   # 灰褐
    (5200, (224, 224, 224)),   # 灰白
    (5800, (245, 247, 248)),   # 雪白
    (9000, (255, 255, 255)),
]


def ramp(h):
    """海拔(m)→RGB，带间平滑插值。"""
    h = np.clip(h, RAMPS[0][0], RAMPS[-1][0])
    for i in range(len(RAMPS) - 1):
        h0, c0 = RAMPS[i]
        h1, c1 = RAMPS[i + 1]
        if h0 <= h <= h1:
            t = (h - h0) / max(1, h1 - h0)
            return tuple(int(round(c0[k] + (c1[k] - c0[k]) * t)) for k in range(3))
    return RAMPS[-1][1]


def main():
    proj = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    # 项目级色带覆盖（2026-09-20 EP7 九寨判例：仓级默认=四川通用色带，九寨青绿 v2 走
    # project.json map.reliefRamps=[(海拔上限, [r,g,b]), ...]——补抓瓦片重渲时色带跟项目走，
    # 不会把新瓦片渲成另一套色系=同画面双色带色差）
    ramps_override = proj.get("map", {}).get("reliefRamps")
    if ramps_override:
        RAMPS[:] = [(int(a), tuple(int(v) for v in c)) for a, c in ramps_override]
    base = Path(sys.argv[1]).resolve().parent
    dem_tpl = proj["map"]["sources"]["dem"]["tiles"]
    out_dir = base / "data/relief"
    zooms = [int(z) for z in (sys.argv[sys.argv.index("--zooms") + 1].split(",") if "--zooms" in sys.argv
             else range(proj["map"]["sources"]["dem"]["minzoom"], proj["map"]["sources"]["dem"]["maxzoom"] + 1))]
    lut = np.array([ramp(h) for h in np.linspace(-100, 7000, 7101)], dtype=np.uint8)
    n = 0
    for z in zooms:
        zdir = base / dem_tpl.split("{z}")[0].replace("{z}", str(z)) / str(z)
        dem_z = base / "data/dem" / str(z)
        if not dem_z.is_dir():
            continue
        for xdir in dem_z.iterdir():
            if not xdir.is_dir():
                continue
            for fp in xdir.glob("*.png"):
                arr = np.asarray(Image.open(fp).convert("RGB"), dtype=np.float32)
                h = arr[..., 0] * 256.0 + arr[..., 1] + arr[..., 2] / 256.0 - 32768.0
                idx = np.clip((h + 100).astype(np.int32), 0, 7100)
                rgb = lut[idx]
                op = out_dir / str(z) / xdir.name
                op.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgb, "RGB").save(op / (fp.stem + ".jpg"), quality=88)
                n += 1
        print(f"z{z} done (cum {n})", flush=True)
    print(f"[relief] {n} tiles -> {out_dir}")


if __name__ == "__main__":
    main()
