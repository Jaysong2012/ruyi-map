#!/usr/bin/env python3
"""通用地图底图+行政边界烘焙（spec 驱动，跨项目复用）。

用法: python3 scripts/map_bake.py <spec.json>
spec:
{
  "out": "projects/<选题>/.work/map.png",       // 产物底图（含边界）
  "geo_out": "projects/<选题>/.work/map.geo.json", // 坐标 sidecar（可选，默认 <out去后缀>.geo.json）
  "window": [94.5, 13.5, 135.0, 45.0],          // 请求窗 [lon0, lat0, lon1, lat1]
  "window_real": [94.5, 13.5, 135.0, 45.0],     // 可选：已实证的真实窗（base_image 模式必填——
                                                //   图片的真实窗脚本无从知晓；给了就以它为 sidecar 真源）
  "zoom": 7,                                     // GIBS epsg4326 瓦片级（Z6=4.5°/512px, Z7=2.25°）
  "base": {"layer": "BlueMarble_NextGeneration", "time": "default",  // time 可省（静态图层）
           "tilematrixset": "250m", "format": "image/jpeg"},
  "base_image": "path/to/existing.jpg",          // 可选：底图已存在则跳过拉取，直接加边界
  "borders": [                                   // 边界层数组，按序绘制
    {"src": "datav:100000_full", "color": [255, 255, 255, 110], "width": 3},   // 中国省界
    {"src": "datav:100000",      "color": [255, 255, 255, 150], "width": 5},   // 中国国界/海岸
    {"src": "ninedash",          "color": [255, 255, 255, 150], "width": 5},   // 十段线
    {"src": "ne:countries",      "color": [255, 255, 255, 90],  "width": 2},   // NaturalEarth 外国界
    {"src": "file:/path/x.geojson", "color": [...], "width": 2}                // 任意 GeoJSON
  ]
}

核心纪律（saudel-reborn 两轮错位学费）：
- **瓦片对齐反推真实窗**：请求窗只是意图，瓦片网格对齐后才是真实窗（//DEG 取整）。
  脚本把真实窗/px_per_deg 写进 geo sidecar——**渲染器一律从 sidecar 读坐标参数，
  不许手写**（手写=下一次错位）。
- epsg4326 瓦片是等距圆柱，x/y 同一 px/°，不存在「双比例」。
- DEG(zoom) = 288 / 2^zoom（Z6=4.5, Z7=2.25，saudel 两点定标实测吻合）。
"""
import json
import math
import os
import subprocess
import sys
import urllib.request
import io
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PKG_DATA = Path(__file__).resolve().parent / "data"
CACHE = Path(os.environ.get("RUYI_MAP_CACHE", Path.home() / ".cache" / "ruyi-map"))
CACHE.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "ruyi-map/0.1 (map baking tool)"}
GIBS = ("https://gibs-a.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetTile"
        "&VERSION=1.0.0&LAYER={layer}&STYLE=default&TILEMATRIXSET={tms}"
        "&TILEMATRIX={z}&FORMAT={fmt}{time}&TILEROW={row}&TILECOL={col}")
TILE_PX = 512

XYZ_PRESETS = {
    "satellite": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    "vector": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "terrain": "https://tile.opentopomap.org/{z}/{x}/{y}.png",
    "dark": "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
}

DATAV = "https://geo.datav.aliyun.com/areas_v3/bound/{code}.json"
NE_COUNTRIES = ("https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/"
                "geojson/ne_110m_admin_0_countries.geojson")


def deg_per_tile(zoom: int) -> float:
    return 288.0 / (2 ** zoom)  # Z6=4.5 Z7=2.25（实测定案）


def align_window(lon0, lat0, lon1, lat1, zoom):
    """请求窗 → 瓦片网格对齐真实窗（返回 lon0', lat0', lon1', lat1', 行列范围）。"""
    D = deg_per_tile(zoom)
    x0, x1 = int((lon0 + 180) // D), int((lon1 + 180) // D)
    y0, y1 = int((90 - lat1) // D), int((90 - lat0) // D)
    return (x0 * D - 180, 90 - (y1 + 1) * D, (x1 + 1) * D - 180, 90 - y0 * D), (x0, x1, y0, y1)


def fetch_tile(url):
    import time
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return r.read()
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


def pull_base(base, win, zoom, out_size):
    """GIBS epsg4326 静态图层 mosaic。"""
    from PIL import Image
    (x0, x1, y0, y1) = win[1]
    tq = f"&TIME={base['time']}" if base.get("time") and base["time"] != "default" else ""
    jobs = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    canvas = Image.new("RGB", ((x1 - x0 + 1) * TILE_PX, (y1 - y0 + 1) * TILE_PX))
    missing = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        urls = [GIBS.format(layer=base["layer"], tms=base.get("tilematrixset", "250m"),
                            z=zoom, fmt=base.get("format", "image/jpeg"), time=tq, row=y, col=x)
                for x, y in jobs]
        for (x, y), data in zip(jobs, ex.map(fetch_tile, urls)):
            if data is None:
                missing.append((x, y))
            else:
                canvas.paste(Image.open(io.BytesIO(data)).convert("RGB"),
                             ((x - x0) * TILE_PX, (y - y0) * TILE_PX))
    if missing:
        sys.exit(f"[map_bake] MISSING {len(missing)} tiles: {missing[:8]}")
    if canvas.size != out_size:
        canvas = canvas.resize(out_size, Image.LANCZOS)
    return canvas


def xyz_tile(lon: float, lat: float, zoom: int):
    n = 2 ** zoom
    x = (lon + 180.0) / 360.0 * n
    lat = max(-85.05112878, min(85.05112878, lat))
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def xyz_lonlat(x: float, y: float, zoom: int):
    n = 2 ** zoom
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def pull_xyz(base, window, zoom):
    """XYZ Web Mercator mosaic；返回图像与瓦片对齐后的真实经纬窗。"""
    from PIL import Image
    lon0, lat0, lon1, lat1 = window
    tx0, ty0 = xyz_tile(lon0, lat1, zoom)
    tx1, ty1 = xyz_tile(lon1, lat0, zoom)
    x0, x1, y0, y1 = math.floor(tx0), math.floor(tx1), math.floor(ty0), math.floor(ty1)
    tile_px = int(base.get("tileSize", 256))
    canvas = Image.new("RGB", ((x1 - x0 + 1) * tile_px, (y1 - y0 + 1) * tile_px))
    template = base.get("url") or XYZ_PRESETS[base["style"]]
    jobs = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    urls = [template.format(z=zoom, x=x, y=y) for x, y in jobs]
    missing = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for (x, y), data in zip(jobs, ex.map(fetch_tile, urls)):
            if data is None:
                missing.append((x, y))
            else:
                canvas.paste(Image.open(io.BytesIO(data)).convert("RGB"),
                             ((x - x0) * tile_px, (y - y0) * tile_px))
    if missing:
        sys.exit(f"[map_bake] MISSING {len(missing)} XYZ tiles: {missing[:8]}")
    west, north = xyz_lonlat(x0, y0, zoom)
    east, south = xyz_lonlat(x1 + 1, y1 + 1, zoom)
    return canvas, (west, south, east, north), (x0, y0, zoom, tile_px)


def load_geojson(src: str):
    """边界数据源：datav:<code> / ninedash / ne:countries / file:<path>。"""
    def fetch(url, cache: Path):
        if not cache.exists():
            r = subprocess.run(["curl", "-sS", "--max-time", "120", url, "-o", str(cache)])
            r.check_returncode()
        return json.loads(cache.read_text())
    if src.startswith("datav:"):
        return fetch(DATAV.format(code=src[6:]), CACHE / f"mapbake_{src[6:]}.json")
    if src == "ninedash":
        return json.loads((PKG_DATA / "ninedash.geojson").read_text())
    if src == "ne:countries":
        return fetch(NE_COUNTRIES, CACHE / "mapbake_world110.json")
    if src.startswith("file:"):
        return json.loads(Path(src[5:]).read_text())
    sys.exit(f"[map_bake] unknown border src: {src}")


def iter_lines(geom):
    t = geom["type"]
    if t == "Polygon":
        yield geom["coordinates"][0]
    elif t == "MultiPolygon":
        for p in geom["coordinates"]:
            yield p[0]
    elif t == "LineString":
        yield geom["coordinates"]
    elif t == "MultiLineString":
        yield from geom["coordinates"]


def iter_features(gj):
    if gj.get("type") == "FeatureCollection":
        yield from (f["geometry"] for f in gj["features"] if f.get("geometry"))
    elif gj.get("type") == "Feature":
        yield gj["geometry"]
    else:
        yield gj


def main():
    spec = json.load(open(sys.argv[1]))
    from PIL import Image, ImageDraw
    zoom = spec.get("zoom", 7)
    lon0, lat0, lon1, lat1 = spec["window"]
    provider = (spec.get("base") or {}).get("provider", "gibs")
    real_win, tiles = align_window(lon0, lat0, lon1, lat1, zoom)
    if spec.get("window_real"):
        real_win = tuple(spec["window_real"])  # 实证窗优先（base_image 模式必填）
    D = deg_per_tile(zoom)
    nx, ny = tiles[1] - tiles[0] + 1, tiles[3] - tiles[2] + 1
    W, H = nx * TILE_PX, ny * TILE_PX
    rlon0, rlat0, rlon1, rlat1 = real_win
    px = TILE_PX / D
    projection = "epsg4326-equirect"
    xyz_meta = None

    if spec.get("base_image"):
        im = Image.open(spec["base_image"]).convert("RGB")
        W, H = im.size
        if spec.get("window_real"):
            pxx, pxy = W / (rlon1 - rlon0), H / (rlat1 - rlat0)
            if abs(pxx - pxy) / pxx > 0.01:
                sys.exit(f"[map_bake] window_real 与图片尺寸比例不符 x={pxx:.2f} y={pxy:.2f} px/°"
                         f"（epsg4326 必须统一——检查实证窗）")
            px = pxx
        elif (W, H) != (nx * TILE_PX, ny * TILE_PX):
            sys.exit(f"[map_bake] base_image {W}x{H} 与请求窗瓦片对齐 {nx * TILE_PX}x{ny * TILE_PX} 不符——"
                     f"请用 window_real 给出该图的实证真实窗")
        im = im.convert("RGBA")
    elif provider == "xyz":
        im, real_win, xyz_meta = pull_xyz(spec["base"], spec["window"], zoom)
        W, H = im.size
        rlon0, rlat0, rlon1, rlat1 = real_win
        projection = "web_mercator"
        im = im.convert("RGBA")
    else:
        im = pull_base(spec["base"], (real_win, tiles), zoom, (W, H)).convert("RGBA")

    def M(lon, lat):
        if projection == "web_mercator":
            tx, ty = xyz_tile(lon, lat, xyz_meta[2])
            return (tx - xyz_meta[0]) * xyz_meta[3], (ty - xyz_meta[1]) * xyz_meta[3]
        return (lon - rlon0) * px, (rlat1 - lat) * px

    lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)  # 写入模式（PIL11 blend 判例：不许用 "RGBA" blend）
    for b in spec.get("borders", []):
        col = tuple(b["color"])
        wdt = b.get("width", 3)
        for geom in iter_features(load_geojson(b["src"])):
            for ring in iter_lines(geom):
                pts = [M(lon, lat) for lon, lat in ring]
                if len(pts) > 1:
                    d.line(pts, fill=col, width=wdt, joint="curve")
    out_im = Image.alpha_composite(im, lay).convert("RGB")
    spec_dir = Path(sys.argv[1]).resolve().parent
    out_path = Path(spec["out"]) if spec["out"].startswith("/") else spec_dir / spec["out"]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_im.save(out_path)

    geo = {
        "crs": projection,
        "projection": projection,
        "bounds": [rlon0, rlat0, rlon1, rlat1],
        "window_real": [rlon0, rlat0, rlon1, rlat1],
        "size": [W, H],
        "px_per_deg": px,
        "note": "lon→x: (lon-w0)*px_per_deg; lat→y: (lat_top-lat)*px_per_deg。"
                "瓦片对齐真实窗（请求窗见 spec，不许手写窗参数，一律读本 sidecar）",
    }
    geo_path = spec.get("geo_out") or spec["out"].rsplit(".", 1)[0] + ".geo.json"
    geo_path = Path(geo_path) if str(geo_path).startswith("/") else spec_dir / geo_path
    json.dump(geo, open(geo_path, "w"), ensure_ascii=False, indent=1)
    print(f"[map_bake] {out_path} {W}x{H} | 真实窗 {real_win} | {px:.2f} px/° | geo → {geo_path}")


if __name__ == "__main__":
    main()
