#!/usr/bin/env python3
"""Prepare only the requested scene window; never downloads global datasets."""
import json, shutil, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def crop_for_bounds(image, source_bounds, target_bounds):
    sw, ss, se, sn = source_bounds
    tw, ts, te, tn = target_bounds
    if not (sw <= tw < te <= se and ss <= ts < tn <= sn):
        raise SystemExit(f"target bounds {target_bounds} exceed source bounds {source_bounds}")
    width, height = image.size
    x0 = round((tw-sw)/(se-sw)*width); x1 = round((te-sw)/(se-sw)*width)
    y0 = round((sn-tn)/(sn-ss)*height); y1 = round((sn-ts)/(sn-ss)*height)
    return image.crop((x0, y0, x1, y1))


def raster(scene_dir, source, target_bounds):
    path = scene_dir / source["path"]
    sidecar = scene_dir / source["geoSidecar"]
    if not path.exists() or not sidecar.exists():
        raise SystemExit(f"missing raster or sidecar: {path}, {sidecar}")
    bounds = json.loads(sidecar.read_text(encoding="utf-8"))["bounds"]
    return crop_for_bounds(Image.open(path), bounds, target_bounds)


scene_path = Path(sys.argv[1]).resolve()
scene_dir = scene_path.parent
scene = json.loads(scene_path.read_text(encoding="utf-8"))
out = scene_dir / scene["output"]["directory"] / "prepared"
out.mkdir(parents=True, exist_ok=True)

dem_source = scene["sources"]["dem"]
if dem_source["format"] != "terrarium":
    if dem_source["format"] == "geotiff" and not shutil.which("gdal_translate"):
        raise SystemExit("GeoTIFF input requires optional gdal_translate backend")
    raise SystemExit(f"unsupported DEM adapter: {dem_source['format']}")
dem = np.asarray(raster(scene_dir, dem_source, scene["bounds"]).convert("RGB"), dtype=np.float32)
height = dem[..., 0] * 256 + dem[..., 1] + dem[..., 2] / 256 - 32768
grid_max = int(scene["output"].get("terrainGridMax", 512))
if max(height.shape) > grid_max:
    scale = grid_max / max(height.shape)
    size = (max(2, round(height.shape[1]*scale)), max(2, round(height.shape[0]*scale)))
    height = np.asarray(Image.fromarray(height, mode="F").resize(size, Image.Resampling.BILINEAR), dtype=np.float32)
np.save(out / "height.npy", height.astype(np.float32))

# Terrain masks are first-class prepared data, following height-field workflows.
# They are deterministic and geo-aligned, so render backends do not infer ecology
# independently from camera-facing normals.
west, south, east, north = scene["bounds"]
lat_c = (south + north) / 2
dx = max(1.0, (east-west) * 111300 * np.cos(np.radians(lat_c)) / max(1, height.shape[1]-1))
dy = max(1.0, (north-south) * 110600 / max(1, height.shape[0]-1))
gy, gx = np.gradient(height, dy, dx)
slope = np.arctan(np.hypot(gx, gy)) / (np.pi / 2)
elevation = (height-np.nanmin(height)) / max(1e-6, np.nanmax(height)-np.nanmin(height))
laplacian = np.gradient(gx, dx, axis=1) + np.gradient(gy, dy, axis=0)
concavity = np.clip((-laplacian-np.nanpercentile(-laplacian, 45)) /
                    max(1e-6, np.nanpercentile(-laplacian, 92)-np.nanpercentile(-laplacian, 45)), 0, 1)
rock = np.clip((slope-.30)/.28, 0, 1) * np.clip((elevation-.28)/.45, 0, 1)
forest = np.clip(1-rock, 0, 1) * np.clip((.88-elevation)/.24, 0, 1)
valley = np.clip((.58-elevation)/.34, 0, 1) * np.maximum(.25, concavity)
aspect = np.arctan2(-gx, gy)
altitude = np.radians(38)
shades = []
for azimuth_degrees in (315, 45, 135, 225):
    azimuth = np.radians(azimuth_degrees)
    shades.append(np.sin(altitude)*np.cos(slope*np.pi/2) +
                  np.cos(altitude)*np.sin(slope*np.pi/2)*np.cos(azimuth-aspect))
hillshade = .55*shades[0] + .15*shades[1] + .15*shades[2] + .15*shades[3]
lo, hi = np.nanpercentile(hillshade, (2, 98))
hillshade = np.clip((hillshade-lo)/max(1e-6, hi-lo), 0, 1)
for name, mask in {"slope": slope, "rock": rock, "forest": forest, "valley": valley, "hillshade": hillshade}.items():
    Image.fromarray(np.uint8(np.clip(mask,0,1)*255), mode="L").save(out / f"{name}-mask.png")

texture = raster(scene_dir, scene["sources"]["texture"], scene["bounds"]).convert("RGB")
texture.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
texture.save(out / "texture.jpg", quality=94, subsampling=0)

# A cinematic albedo keeps the source image's real spatial detail while replacing
# inconsistent satellite color with a controlled verdant palette. Local luminance
# variation is retained so this does not collapse into a flat elevation tint.
rgb = np.asarray(texture, dtype=np.float32) / 255
lum = rgb[..., 0]*.2126 + rgb[..., 1]*.7152 + rgb[..., 2]*.0722
lo, hi = np.percentile(lum, (1, 99))
tone = np.clip((lum-lo)/max(1e-6, hi-lo), 0, 1)
stops = np.array([0, .24, .48, .72, 1], dtype=np.float32)
palette = np.array([[.018,.075,.060], [.025,.15,.075], [.055,.28,.12],
                    [.18,.40,.18], [.48,.52,.32]], dtype=np.float32)
graded = np.stack([np.interp(tone, stops, palette[:,i]) for i in range(3)], axis=-1)
blur = np.asarray(Image.fromarray(np.uint8(tone*255), mode="L").filter(ImageFilter.GaussianBlur(10)), dtype=np.float32)/255
local = np.clip((tone-blur)[...,None]*.85, -.16, .16)
graded = np.clip(graded + local, 0, 1)
Image.fromarray(np.uint8(graded*255), mode="RGB").save(out / "albedo.jpg", quality=95, subsampling=0)

route_out = None
if scene["sources"].get("routes"):
    route_path = scene_dir / scene["sources"]["routes"]
    if not route_path.exists():
        raise SystemExit(f"missing routes: {route_path}")
    route_out = out / "routes.geojson"
    shutil.copyfile(route_path, route_out)

water_out = None
if scene["sources"].get("water"):
    water_path = scene_dir / scene["sources"]["water"]
    if not water_path.exists():
        raise SystemExit(f"missing water: {water_path}")
    water_out = out / "water.geojson"
    shutil.copyfile(water_path, water_out)

manifest = {
    "schemaVersion": 1, "scene": scene["name"], "bounds": scene["bounds"],
    "policy": "window-only", "height": "height.npy", "texture": "texture.jpg", "albedo": "albedo.jpg",
    "masks": {name: f"{name}-mask.png" for name in ("slope", "rock", "forest", "valley", "hillshade")},
    "routes": route_out.name if route_out else None,
    "water": water_out.name if water_out else None,
    "grid": {"rows": int(height.shape[0]), "cols": int(height.shape[1]),
             "minimumMeters": float(np.nanmin(height)), "maximumMeters": float(np.nanmax(height))},
    "inputs": scene["sources"]
}
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print(f"PREPARED {height.shape[1]}x{height.shape[0]} -> {out}")
