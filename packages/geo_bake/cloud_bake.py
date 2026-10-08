#!/usr/bin/env python3
"""通用云系层烘焙（GIBS 云图 → 云 mask RGBA 层，对齐目标底图坐标系）。

用法: python3 scripts/cloud_bake.py <spec.json>
spec:
{
  "src": "projects/<选题>/.work/gibs_color/xx.jpg",  // GIBS 云图（himawari_mosaic 产物或真彩版）
  "src_window": [99.0, 9.0, 139.5, 40.5],            // 云图真实窗 [lon0, lat0, lon1, lat1]
                                                     // ——用 himawari_mosaic 时按瓦片对齐算（它打印尺寸，
                                                     //   或用 align_window 同款逻辑；不许照抄请求窗）
  "target_geo": "projects/<选题>/.work/map.geo.json", // map_bake 坐标 sidecar
  "out": "projects/<选题>/.work/cloud_x.png",
  "mask": {"lo": 90, "hi": 200, "blur": 6},          // 云亮度阈值带（海暗云亮），高斯柔边
  "half": true                                        // 半尺寸存储（云系低频，省内存）
}

纪律：云图真实窗同样必须实证（himawari_mosaic 请求 100 12 135 40
→ 瓦片对齐 lon99-139.5 lat9-40.5——lat_top=90-11×4.5=40.5 不是 45，「日本在广东」判例）。
 warp 只做线性缩放+平移（两窗都是 epsg4326 等距圆柱）。
"""
import json
import sys
from pathlib import Path
import math
from PIL import Image, ImageFilter

_SPEC_DIR = None  # main() 里置为 spec 文件目录，相对路径以此解析


def main():
    global _SPEC_DIR
    _SPEC_DIR = Path(sys.argv[1]).resolve().parent
    spec = json.load(open(sys.argv[1]))
    geo = json.load(open(spec["target_geo"] if spec["target_geo"].startswith("/")
                         else _SPEC_DIR / spec["target_geo"]))
    bw0, blat0, bw1, blat1 = geo.get("bounds") or geo["window_real"]
    BW, BH = geo["size"]
    projection = geo.get("projection") or geo.get("crs", "epsg4326-equirect")
    clon0, clat0, clon1, clat1 = spec["src_window"]

    im = Image.open(spec["src"] if spec["src"].startswith("/") else _SPEC_DIR / spec["src"])
    im = im.convert("RGB")
    cw, ch = im.size
    cpx_x, cpx_y = cw / (clon1 - clon0), ch / (clat1 - clat0)
    mk = spec.get("mask", {})
    lo, hi, blur = mk.get("lo", 90), mk.get("hi", 200), mk.get("blur", 6)
    lum = im.convert("L")
    mask = lum.point(lambda v: max(0, min(255, int((v - lo) * 255 / (hi - lo)))))
    if blur:
        mask = mask.filter(ImageFilter.GaussianBlur(blur))
    rgba = im.convert("RGBA")
    rgba.putalpha(mask)
    if projection == "web_mercator":
        def merc_y(lat): return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
        def lat_at(y):
            my = merc_y(blat1) + (merc_y(blat0) - merc_y(blat1)) * y / BH
            return math.degrees(2 * math.atan(math.exp(my)) - math.pi / 2)
        sx0 = (bw0 - clon0) * cpx_x
        sx1 = (bw1 - clon0) * cpx_x
        mesh = []
        strip = max(2, BH // 512)
        for y0 in range(0, BH, strip):
            y1 = min(BH, y0 + strip)
            sy0 = (clat1 - lat_at(y0)) * cpx_y
            sy1 = (clat1 - lat_at(y1)) * cpx_y
            mesh.append(((0, y0, BW, y1), (sx0, sy0, sx1, sy0, sx1, sy1, sx0, sy1)))
        layer = rgba.transform((BW, BH), Image.Transform.MESH, mesh, Image.Resampling.BILINEAR)
        detail = f"web_mercator mesh strips={len(mesh)}"
    else:
        bpx = geo["px_per_deg"]
        sx, sy = bpx / cpx_x, bpx / cpx_y
        if abs(sx - sy) / sx > 0.01:
            print(f"[cloud_bake] WARN 缩放比 x/y 不一致 {sx:.3f}/{sy:.3f}——检查 src_window 是否真实")
        rgba = rgba.resize((round(cw * sx), round(ch * sy)), Image.LANCZOS)
        ox = round((clon0 - bw0) * bpx)
        oy = round((blat1 - clat1) * bpx)
        layer = Image.new("RGBA", (BW, BH), (0, 0, 0, 0))
        layer.paste(rgba, (ox, oy))
        detail = f"scale=({sx:.3f},{sy:.3f}) offset=({ox},{oy})"
    if spec.get("half"):
        layer = layer.resize((BW // 2, BH // 2), Image.LANCZOS)
    out = spec["out"] if spec["out"].startswith("/") else _SPEC_DIR / spec["out"]
    out.parent.mkdir(parents=True, exist_ok=True)
    layer.save(out)
    print(f"[cloud_bake] {out} | src {cw}x{ch} → {detail} | half={bool(spec.get('half'))}")


if __name__ == "__main__":
    main()
