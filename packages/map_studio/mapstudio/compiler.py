#!/usr/bin/env python3
"""Compile Map Studio v2 authoring data into a deterministic render contract."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

MODES = {
    "walk": {"color": "#44e3a1", "dash": False, "label": "步行"},
    "bus": {"color": "#ff9f43", "dash": False, "label": "大巴"},
    "cable": {"color": "#ffd166", "dash": True, "label": "索道"},
    "rail": {"color": "#b989ff", "dash": True, "label": "地轨"},
    "boat": {"color": "#55c7ff", "dash": True, "label": "船"},
    "drive": {"color": "#ff704d", "dash": False, "label": "驾车"},
    # flight（EP6川西 v2 直飞航线，2026-09-17）：浅蓝白虚线=高空航线语感，与 drive 橙红冷暖对撞
    "flight": {"color": "#9fd8ff", "dash": True, "label": "直飞"},
}


def _read(base: Path, value: str) -> dict:
    path = (base / value).resolve()
    try:
        path.relative_to(base.resolve())
    except ValueError as exc:
        raise ValueError(f"input escapes project directory: {value}") from exc
    if not path.is_file():
        raise ValueError(f"missing input: {value}")
    return json.loads(path.read_text(encoding="utf-8"))


def _ids(items: list[dict], kind: str) -> dict[str, dict]:
    result = {}
    for item in items:
        key = item.get("id")
        if not isinstance(key, str) or not key:
            raise ValueError(f"{kind} id must be a non-empty string")
        if key in result:
            raise ValueError(f"duplicate {kind} id: {key}")
        result[key] = item
    return result


def _point(value, label: str) -> list[float]:
    if not (isinstance(value, list) and len(value) == 2 and all(isinstance(x, (int, float)) for x in value)):
        raise ValueError(f"{label} must be [lon, lat]")
    lon, lat = value
    if not (-180 <= lon <= 180 and -85.051129 <= lat <= 85.051129):
        raise ValueError(f"{label} is outside Web Mercator")
    return [float(lon), float(lat)]


def _distance(a, b) -> float:
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111_320 * math.cos(lat), (a[1] - b[1]) * 110_574)


def _dem_elev(base: Path, tpl: str, lon: float, lat: float, z: int, cache: dict):
    """从本地 terrarium dem 瓦片解码单点海拔（米）；瓦片缺失返回 None。"""
    from PIL import Image  # 延迟导入：无 dem 源的项目不强制 PIL
    n = 2 ** z
    fx = (lon + 180) / 360 * n
    rlat = math.radians(lat)
    fy = (1 - math.log(math.tan(rlat) + 1 / math.cos(rlat)) / math.pi) / 2 * n
    tx, ty = int(fx), int(fy)
    if (tx, ty) not in cache:
        path = base / tpl.replace("{z}", str(z)).replace("{x}", str(tx)).replace("{y}", str(ty))
        cache[(tx, ty)] = Image.open(path).convert("RGB") if path.exists() else None
    im = cache[(tx, ty)]
    if im is None:
        return None
    r, g, b = im.load()[min(255, int((fx - tx) * 256)), min(255, int((fy - ty) * 256))][:3]
    return round(r * 256 + g + b / 256 - 32768, 1)


def _ground_profile(base: Path, project: dict, coords: list, samples: int = 64):
    """沿段弧长等距采样地面海拔，供渲染期 AGL 恒定相机补偿（queryTerrainElevation 运行时不可信判例）。
    密度按 ~30m 间距自适应（EP3 D2 判例：64 点=208m 间距，点间线性插值 vs DEM 真实起伏错位×TEX 放大
    → 相机移动时路线在坡上滑动=「漂移」判死；208m→30m 后贴地滑动不可见）。"""
    dem = project.get("map", {}).get("sources", {}).get("dem")
    if not (isinstance(dem, dict) and isinstance(dem.get("tiles"), str)):
        return None
    z = min(int(dem.get("maxzoom", 13)), 13)  # 与渲染期 dem 锁级一致（z13=7.6m/px 石柱林稳定判例）
    lens = [0.0]
    for a, b in zip(coords, coords[1:]):
        lens.append(lens[-1] + _distance(a, b))
    total = lens[-1]
    if total <= 0:
        return None
    samples = max(samples, min(1024, int(total / 30)))
    cache: dict = {}
    profile = []
    for i in range(samples):
        d = total * i / (samples - 1)
        j = 1
        while j < len(lens) and lens[j] < d:
            j += 1
        if j >= len(coords):
            pt = coords[-1]
        else:
            q = (d - lens[j - 1]) / (lens[j] - lens[j - 1] or 1)
            pt = [coords[j - 1][0] + (coords[j][0] - coords[j - 1][0]) * q,
                  coords[j - 1][1] + (coords[j][1] - coords[j - 1][1]) * q]
        profile.append(_dem_elev(base, dem["tiles"], pt[0], pt[1], z, cache))
    if all(v is None for v in profile):
        return None
    return profile


def _dem_grid(base: Path, project: dict, bounds: list, cols: int = 128, rows: int = 128):
    """逐像素 maxpool dem 网格（编译期烘焙）：渲染期视线净空判定用——icon/标注在地形遮挡时与原生线同隐同现（GL 对齐终件判例）。
    必须逐像素取 MAX：5×5 子采样会漏掉脊线真高→净空误判可见→icon 该淡不淡（t=8 判例）。"""
    dem = project.get("map", {}).get("sources", {}).get("dem")
    if not (isinstance(dem, dict) and isinstance(dem.get("tiles"), str)):
        return None
    from PIL import Image  # 延迟导入
    z = min(int(dem.get("maxzoom", 13)), 13)
    tpl = dem["tiles"]
    n = 2 ** z

    def to_px(lon, lat):
        fx = (lon + 180) / 360 * n * 256
        rlat = math.radians(lat)
        fy = (1 - math.log(math.tan(rlat) + 1 / math.cos(rlat)) / math.pi) / 2 * n * 256
        return fx, fy

    def tile(z_, tx, ty, cache):
        if (tx, ty) not in cache:
            path = base / tpl.replace("{z}", str(z_)).replace("{x}", str(tx)).replace("{y}", str(ty))
            cache[(tx, ty)] = Image.open(path).convert("RGB") if path.exists() else None
        return cache[(tx, ty)]

    west, south, east, north = bounds
    cache: dict = {}
    vals = []
    for r in range(rows):
        lat_s = south + (north - south) * r / rows
        lat_n = south + (north - south) * (r + 1) / rows
        for c in range(cols):
            lon_w = west + (east - west) * c / cols
            lon_e = west + (east - west) * (c + 1) / cols
            fx0, fy0 = to_px(lon_w, lat_n)  # 北边缘 fy 小
            fx1, fy1 = to_px(lon_e, lat_s)
            mx = None
            for tx in range(int(fx0) // 256, int(fx1) // 256 + 1):
                for ty in range(int(fy0) // 256, int(fy1) // 256 + 1):
                    im = tile(z, tx, ty, cache)
                    if im is None:
                        continue
                    ld = im.load()
                    px0, px1 = max(0, int(fx0) - tx * 256), min(255, int(fx1) - tx * 256)
                    py0, py1 = max(0, int(fy0) - ty * 256), min(255, int(fy1) - ty * 256)
                    for py in range(py0, py1 + 1):
                        for px in range(px0, px1 + 1):
                            rr, gg, bb = ld[px, py][:3]
                            e = rr * 256 + gg + bb / 256 - 32768
                            if mx is None or e > mx:
                                mx = e
            vals.append(round(mx, 1) if mx is not None else None)
    if all(v is None for v in vals):
        return None
    return {"west": west, "south": south, "east": east, "north": north, "cols": cols, "rows": rows, "values": vals}


def compile_project(project_path: Path) -> tuple[dict, Path]:

    project_path = project_path.resolve()
    base = project_path.parent
    project = json.loads(project_path.read_text(encoding="utf-8"))
    if project.get("schemaVersion") != 2:
        raise ValueError("project schemaVersion must be 2")
    inputs = project.get("inputs", {})
    for name in ("locations", "routes", "storyboard"):
        if not isinstance(inputs.get(name), str):
            raise ValueError(f"inputs.{name} is required")
    locations_doc = _read(base, inputs["locations"])
    routes_doc = _read(base, inputs["routes"])
    storyboard = _read(base, inputs["storyboard"])
    locations = _ids(locations_doc.get("locations", []), "location")
    bounds = project.get("map", {}).get("bounds")
    if not (isinstance(bounds, list) and len(bounds) == 4):
        raise ValueError("map.bounds must be [west, south, east, north]")
    west, south, east, north = bounds
    if not (-180 <= west < east <= 180 and -85.051129 <= south < north <= 85.051129):
        raise ValueError("invalid map.bounds")
    for key, item in locations.items():
        coord = _point(item.get("coordinates"), f"location {key}")
        if not (west <= coord[0] <= east and south <= coord[1] <= north):
            raise ValueError(f"location outside map.bounds: {key}")
        item["coordinates"] = coord
        dem = project.get("map", {}).get("sources", {}).get("dem")
        if isinstance(dem, dict) and isinstance(dem.get("tiles"), str):
            g = _dem_elev(base, dem["tiles"], coord[0], coord[1], min(int(dem.get("maxzoom", 13)), 13), {})
            if g is not None:
                item["ground"] = g  # 地点地面海拔：Marker setAltitude 贴地用（运行时 queryTerrainElevation 不可信判例）

    segments = _ids(routes_doc.get("segments", []), "segment")
    compiled_segments = []
    for key, segment in segments.items():
        mode = segment.get("mode")
        if mode not in MODES:
            raise ValueError(f"unknown transport mode in {key}: {mode}")
        refs = segment.get("locations")
        coords = segment.get("coordinates")
        if coords is not None:
            # 显式坐标（真实路网轨迹）优先；locations 仅作起终点标注参考
            if not (isinstance(coords, list) and len(coords) >= 2):
                raise ValueError(f"segment {key} coordinates must contain at least two points")
        elif refs is not None:
            if not (isinstance(refs, list) and len(refs) >= 2):
                raise ValueError(f"segment {key} locations must contain at least two ids")
            unknown = [x for x in refs if x not in locations]
            if unknown:
                raise ValueError(f"segment {key} references unknown locations: {', '.join(unknown)}")
            coords = [locations[x]["coordinates"] for x in refs]
        else:
            raise ValueError(f"segment {key} needs locations or coordinates")
        coords = [_point(x, f"segment {key} coordinate") for x in coords]
        for a, b in zip(coords, coords[1:]):
            if _distance(a, b) > float(segment.get("maximumGapMeters", 20_000)):
                raise ValueError(f"segment {key} has a discontinuity larger than maximumGapMeters")
        style = {**MODES[mode], **segment.get("style", {})}
        endpoints = {}
        for end_key, end_coord in (("from", coords[0]), ("to", coords[-1])):
            near = min(locations.items(), key=lambda kv: _distance(kv[1]["coordinates"], end_coord), default=None)
            if near and _distance(near[1]["coordinates"], end_coord) <= 250:
                endpoints[end_key] = near[1].get("name", near[0])
        entry = {"id": key, "mode": mode, "coordinates": coords, "style": style, "endpoints": endpoints}
        if isinstance(segment.get("agl"), (int, float)) and segment["agl"] > 0:
            entry["agl"] = float(segment["agl"])
        profile = _ground_profile(base, project, coords)
        if profile:
            entry["groundProfile"] = profile
        dem_src = project.get("map", {}).get("sources", {}).get("dem")
        if isinstance(dem_src, dict) and isinstance(dem_src.get("tiles"), str):
            elevs = [_dem_elev(base, dem_src["tiles"], c[0], c[1], min(int(dem_src.get("maxzoom", 13)), 13), {}) for c in coords]
            if any(v is not None for v in elevs):
                entry["elevations"] = elevs  # 逐顶点海拔（与 terrain mesh 同 dem 同锁级=overlay 贴地零漂移判例：插值剖面在陡坡错位→icon 飘）
        compiled_segments.append(entry)

    duration = storyboard.get("durationSeconds")
    if not isinstance(duration, (int, float)) or duration <= 0:
        raise ValueError("storyboard.durationSeconds must be positive")
    events = storyboard.get("events", [])
    allowed = {"route", "camera", "callout", "marker", "hold", "summary", "panel"}
    previous = -1.0
    route_end = -1.0
    compiled_events = []
    for index, event in enumerate(events):
        kind = event.get("type")
        if kind not in allowed:
            raise ValueError(f"unknown event type at index {index}: {kind}")
        start = event.get("start")
        end = event.get("end", start)
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not (0 <= start <= end <= duration):
            raise ValueError(f"event {index} has invalid time range")
        if start < previous:
            raise ValueError(f"events must be ordered by start time (index {index})")
        previous = float(start)
        if "segment" in event and event["segment"] not in segments:
            raise ValueError(f"event {index} references unknown segment: {event['segment']}")
        if "location" in event and event["location"] not in locations:
            raise ValueError(f"event {index} references unknown location: {event['location']}")
        if kind == "route":
            if "segment" not in event:
                raise ValueError(f"route event {index} needs segment")
            if start < route_end:
                raise ValueError(f"route events overlap at index {index}")
            route_end = float(end)
        compiled_events.append(event)

    output = project.get("output", {})
    if not all(isinstance(output.get(x), int) and output[x] > 0 for x in ("width", "height", "fps")):
        raise ValueError("output width, height and fps must be positive integers")
    compiled = {
        "schemaVersion": 2,
        "name": project.get("name", base.name),
        "map": project["map"],
        "output": output,
        "locations": list(locations.values()),
        "segments": compiled_segments,
        "storyboard": {"durationSeconds": float(duration), "events": compiled_events},
    }
    dem = project.get("map", {}).get("sources", {}).get("dem")
    if isinstance(dem, dict) and isinstance(dem.get("tiles"), str):
        mc = project["map"].get("center")
        if isinstance(mc, list) and len(mc) == 2:
            g = _dem_elev(base, dem["tiles"], mc[0], mc[1], min(int(dem.get("maxzoom", 13)), 13), {})
            if g is not None:
                compiled["map"]["ground"] = g  # 相机参考面基准：冻结 elevation 用（贴地语义+确定性数据判例）
        grid = _dem_grid(base, project, bounds)
        if grid:
            compiled["map"]["demGrid"] = grid  # 视线净空判定网格（遮挡淡出判例）
    for extra in ("title", "subtitle"):
        if isinstance(storyboard.get(extra), str):
            compiled["storyboard"][extra] = storyboard[extra]
    canonical = json.dumps(compiled, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    compiled["build"] = {
        "contractSha256": hashlib.sha256(canonical.encode()).hexdigest(),
        "inputs": {name: inputs[name] for name in sorted(inputs)},
    }
    out_dir = base / output.get("directory", "output")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "compiled.json"
    out_path.write_text(json.dumps(compiled, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return compiled, out_path


def qa_compiled(doc: dict) -> list[str]:
    errors = []
    events = doc.get("storyboard", {}).get("events", [])
    route_events = [x for x in events if x.get("type") == "route"]
    if not route_events:
        errors.append("storyboard has no route event")
    used = {x.get("segment") for x in route_events}
    unused = [x["id"] for x in doc.get("segments", []) if x["id"] not in used]
    if unused:
        errors.append("segments never shown: " + ", ".join(unused))
    return errors
