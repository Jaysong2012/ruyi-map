#!/usr/bin/env python3
"""fetch_terrain_block.py — terrain_block 场景数据包获取（仓级；nepal-mudslide/fetch_terrain.py 2026-09-26 下沉参数化）

Terrarium DEM + Esri World Imagery → terrain_block 数据契约（render_scene.mjs program=terrain_block 消费）：
  <out>/heights.f32   Float32 小端高度网格（行主序，北→南、西→东），单位米
  <out>/surface.jpg   Esri 影像拼接纹理
  <out>/mask.bin      Uint8 掩膜（本器全 1=整块保留；边缘收边由渲染器 BFS 径向衰减负责）
  <out>/meta.json     cols/rows/地理范围/海拔范围

用法: python3 scripts/fetch_terrain_block.py <out_dir> <z> <lon0> <lon1> <lat0> <lat1>
  例（EP9 亚丁块）: python3 scripts/fetch_terrain_block.py projects/.../map3d 13 100.28 100.42 28.34 28.60
判例：国外源（Terrarium/S3）走 https_proxy；Esri 国内直连。媒体不入 git。
"""
import io, json, math, os, struct, sys, time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen

from PIL import Image
Image.MAX_IMAGE_PIXELS = None

OUT, Z = sys.argv[1], int(sys.argv[2])
LON0, LON1, LAT0, LAT1 = map(float, sys.argv[3:7])   # lat0=南 lat1=北
os.makedirs(OUT, exist_ok=True)

def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y

x0f, y1f = lonlat_to_tile(LON0, LAT0, Z)
x1f, y0f = lonlat_to_tile(LON1, LAT1, Z)
X0, X1 = int(math.floor(x0f)), int(math.floor(x1f))
Y0, Y1 = int(math.floor(y0f)), int(math.floor(y1f))
COLS, ROWS = (X1 - X0 + 1) * 256, (Y1 - Y0 + 1) * 256
print(f"tiles x:{X0}..{X1} y:{Y0}..{Y1} → grid {COLS}×{ROWS}", flush=True)

def fetch(url, retries=5):
    for k in range(retries):
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=45) as r:
                return r.read()
        except Exception:
            if k == retries - 1:
                raise
            time.sleep(1.5 * (k + 1))

# ---- DEM（Terrarium：h = R*256 + G + B/256 - 32768）----
dem_items = [(x, y) for y in range(Y0, Y1 + 1) for x in range(X0, X1 + 1)]
def fetch_dem(item):
    x, y = item
    url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png"
    img = Image.open(io.BytesIO(fetch(url))).convert("RGB")
    return x, y, img

heights = [[0.0] * COLS for _ in range(ROWS)]
with ThreadPoolExecutor(max_workers=8) as ex:
    for x, y, img in ex.map(fetch_dem, dem_items):
        px = img.load()
        ox, oy = (x - X0) * 256, (y - Y0) * 256
        for j in range(256):
            row = heights[oy + j]
            for i in range(256):
                r, g, b = px[i, j]
                row[ox + i] = r * 256 + g + b / 256 - 32768
        print(f"DEM {x},{y} ok", flush=True)

flat = [h for row in heights for h in row]
with open(os.path.join(OUT, "heights.f32"), "wb") as f:
    f.write(struct.pack(f"<{len(flat)}f", *flat))

# ---- Esri 影像纹理 ----
def fetch_img(item):
    x, y = item
    url = f"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{Z}/{y}/{x}"
    return x, y, Image.open(io.BytesIO(fetch(url))).convert("RGB")

surface = Image.new("RGB", (COLS, ROWS))
with ThreadPoolExecutor(max_workers=8) as ex:
    for x, y, img in ex.map(fetch_img, dem_items):
        surface.paste(img, ((x - X0) * 256, (y - Y0) * 256))
        print(f"IMG {x},{y} ok", flush=True)
surface.save(os.path.join(OUT, "surface.jpg"), quality=88)

# ---- mask 全 1 + meta ----
with open(os.path.join(OUT, "mask.bin"), "wb") as f:
    f.write(bytes([1]) * (COLS * ROWS))

hmin, hmax = min(flat), max(flat)
json.dump({
    "z": Z, "x0": X0, "y0": Y0, "w": COLS, "h": ROWS,
    "lon0": LON0, "lon1": LON1, "lat0": LAT0, "lat1": LAT1,
    "hmin": round(hmin, 1), "hmax": round(hmax, 1),
}, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
print(f"done: {COLS}×{ROWS} 海拔 {hmin:.0f}-{hmax:.0f}m → {OUT}")
