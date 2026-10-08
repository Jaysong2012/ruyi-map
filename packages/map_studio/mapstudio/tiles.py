#!/usr/bin/env python3
"""按场景 bounds 抓取本地卫星与 Terrarium DEM 瓦片（只抓窗口，不抓全球）。

瓦片落入 project.json 里 map.sources 声明的 data 目录；已存在即跳过。
Esri 卫星与 AWS elevation-tiles 均为海外源，走 https_proxy 环境变量（urllib 自动遵守）。
"""
from __future__ import annotations

import json
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SAT_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def _deg2tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def _grab(url: str, fp: Path, tries: int = 3) -> bool:
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            fp.write_bytes(urllib.request.urlopen(req, timeout=30).read())
            return True
        except Exception:
            time.sleep(1.2 * (i + 1))
    return False


def _route_corridor_windows(base: Path, project: dict, pad_deg: float) -> list[tuple[float, float, float, float]]:
    """跟拍走廊：按 routes.json 每段坐标外包框 + pad（度）生成一组小窗口，替代全区域大窗口。
    病根（EP3 D2 判例）：全区域 z14 需 4731 张超 4000 闸被跳过 → z14 从未抓全，跟拍 agl 请求 z14 时
    引擎混用低级瓦片放大 = 地面纹理跳 = 路线看着漂。走廊窗口只覆盖相机真正经过的地方。"""
    routes_rel = project.get("inputs", {}).get("routes")
    if not routes_rel:
        raise ValueError("corridor 模式需要 inputs.routes")
    doc = json.loads((base / routes_rel).read_text(encoding="utf-8"))
    wins = []
    for seg in doc.get("segments", []):
        coords = seg.get("coordinates") or []
        if len(coords) < 2:
            continue
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        wins.append((min(xs) - pad_deg, min(ys) - pad_deg, max(xs) + pad_deg, max(ys) + pad_deg))
    if not wins:
        raise ValueError("routes.json 无带坐标的 segments（locations 引用式路线先 build 编译出坐标）")
    return wins


def fetch_tiles(project_path: Path, corridor: bool = False, corridor_pad_deg: float = 0.02,
                zooms: list[int] | None = None) -> list[str]:
    """抓 project.map.sources 声明的本地瓦片。默认按全区域视野窗口；corridor=True 只抓路线走廊
    （zooms 指定级别，默认 sources 的 maxzoom 与 maxzoom-1）。"""
    project_path = project_path.resolve()
    base = project_path.parent
    project = json.loads(project_path.read_text(encoding="utf-8"))
    west, south, east, north = project["map"]["bounds"]
    out = project.get("output", {})
    # 抓取窗口必须覆盖 summary 拉远后的最大视野：扁 bounds fit 进宽画幅时，
    # 视野宽 = bounds高 × 画幅宽高比，可能数倍于 bounds 宽（九寨沟 z12 整批 404 判例）。
    aspect = (out.get("width", 1280)) / (out.get("height", 720))
    cy, cx = (south + north) / 2, (west + east) / 2
    half_h = max((north - south) / 2, (east - west) / 2 / aspect) * 2.2  # 锁单 z 级后必须覆盖 summary 全景最大视野（D2 z15 判例）
    half_w = half_h * aspect
    windows = [(cx - half_w, cy - half_h, cx + half_w, cy + half_h)]
    if corridor:
        windows = _route_corridor_windows(base, project, corridor_pad_deg)
    sources = project["map"]["sources"]
    jobs = []
    skipped: list[str] = []
    for kind, url_tpl in (("satellite", SAT_URL), ("dem", DEM_URL)):
        src = sources.get(kind)
        if not src:
            continue
        tiles = src["tiles"]
        if tiles.startswith("http"):
            continue  # 远程源不需要落地
        zmin, zmax = int(src.get("minzoom", 4)), int(src.get("maxzoom", 12))
        levels = [z for z in (zooms or range(zmin, zmax + 1)) if zmin <= z <= zmax] if not corridor else \
            [z for z in (zooms or [zmax - 1, zmax]) if z >= 0]
        for z in levels:
            want: set[tuple[int, int]] = set()
            for (w_, s_, e_, n_) in windows:
                x0, y1 = _deg2tile(w_, s_, z)
                x1, y0 = _deg2tile(e_, n_, z)
                pad = 2 if corridor else 4  # 相机拉远/平移会请求 bounds 外瓦片（九寨沟 z12 整批 404 判例）；pitch 54 大俯角视野更大（EP3 张家界 404 判例），外扩 4 张
                n = 2 ** z
                x0, x1 = max(0, x0 - pad), min(n - 1, x1 + pad)
                y0, y1 = max(0, y0 - pad), min(n - 1, y1 + pad)
                want.update((x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1))
            if len(want) > 4000:
                msg = f"skip {kind} z{z}: window too large ({len(want)} tiles)——用 --corridor 只抓路线走廊"
                print(f"  {msg}", flush=True)
                skipped.append(msg)
                continue  # 该级窗口过大，跳过明显失控级别并明示
            for x, y in sorted(want):
                fp = base / tiles.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
                if fp.exists():
                    continue
                jobs.append((url_tpl.format(z=z, x=x, y=y), fp))
    done = 0
    def work(job):
        nonlocal done
        url, fp = job
        fp.parent.mkdir(parents=True, exist_ok=True)
        ok = _grab(url, fp)
        done += 1
        if done % 100 == 0:
            print(f"  tiles {done}/{len(jobs)}", flush=True)
        return ok
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(work, jobs))
    failed = len([r for r in results if not r])
    if failed:
        raise ValueError(f"{failed}/{len(jobs)} tiles failed（海外源需 https_proxy；重跑补齐）")
    return [f"fetched {len(jobs) - failed} tiles, {failed} failed" + (f"; skipped: {'; '.join(skipped)}" if skipped else "")]


def _tile2deg(x: int, y: int, z: int) -> tuple[float, float]:
    n = 2 ** z
    lon = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def build_pyramid(project_path: Path, min_zoom: int = 9) -> list[str]:
    """离线瓦片金字塔：从最高级瓦片逐层向下拼缩（每张=子级 2×2 拼合后 LANCZOS 缩半）。

    防幌判例的核心：全 z 级瓦片同源（同一 z15 数据降采样），zoom 跨级切换时
    内容零跳变、只有清晰度渐变。serve 动态降采样是反方向（裁象限=overzoom），废弃。
    """
    from PIL import Image

    project_path = project_path.resolve()
    base = project_path.parent
    project = json.loads(project_path.read_text(encoding="utf-8"))
    logs = []
    for kind in ("satellite", "dem"):
        src = project["map"]["sources"].get(kind)
        if not src or src["tiles"].startswith("http"):
            continue
        tpl, ext = src["tiles"], src["tiles"].rsplit(".", 1)[-1]
        lock = int(src["maxzoom"])
        lock_dir = base / tpl.replace("{z}", str(lock)).rsplit("/", 2)[0]
        xs = [int(d.name) for d in lock_dir.glob("*") if d.is_dir() and d.name.isdigit()]
        if not xs:
            logs.append(f"{kind}: no z{lock} tiles, run fetch-tiles first")
            continue
        ys = [int(f.stem) for d in lock_dir.glob("*") if d.is_dir() and d.name.isdigit()
              for f in d.glob(f"*.{ext}") if f.stem.isdigit()]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        for z in range(lock - 1, min_zoom - 1, -1):
            dz = lock - z
            span = 1 << dz  # 每目标瓦片对应 lock 级 span×span 子瓦片
            zx0, zx1, zy0, zy1 = x0 >> dz, x1 >> dz, y0 >> dz, y1 >> dz
            n = 0
            for x in range(zx0, zx1 + 1):
                for y in range(zy0, zy1 + 1):
                    out_fp = base / tpl.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
                    if out_fp.exists():
                        continue
                    # 直接从 lock 级一次合成（张家界清晰度判例：链式 z+1 降采样每级 LANCZOS+JPEG90 模糊累积，
                    # 远景像蒙纱；一次性从 lock 级拼 span×span 再单次缩到 256=只有一级模糊）
                    canvas = Image.new("RGB", (256 * span, 256 * span), (12, 16, 13))
                    for cx in range(span):
                        for cy in range(span):
                            child = base / tpl.replace("{z}", str(lock)).replace("{x}", str(x * span + cx)).replace("{y}", str(y * span + cy))
                            if child.exists():
                                canvas.paste(Image.open(child).convert("RGB"), (cx * 256, cy * 256))
                    canvas = canvas.resize((256, 256), Image.LANCZOS)
                    out_fp.parent.mkdir(parents=True, exist_ok=True)
                    canvas.save(out_fp) if ext == "png" else canvas.save(out_fp, quality=95, subsampling=0)
                    n += 1
            logs.append(f"{kind} z{z}: {n} tiles (direct from z{lock})")
    return logs


def stitch_tiles(project_path: Path, out_name: str = "prepared-src") -> list[str]:
    """把 project.json 声明的本地瓦片目录各拼成一张大图 + geoSidecar（实际瓦片范围）。

    供 Blender 后端 prepare 消费：瓦片流是 MapLibre 逐帧渲染的数据形态，
    单张大图才是离线 3D 渲染的数据形态。缺瓦片以透明洞示人并记入返回日志。
    """
    from PIL import Image

    project_path = project_path.resolve()
    base = project_path.parent
    project = json.loads(project_path.read_text(encoding="utf-8"))
    sources = project["map"]["sources"]
    out_dir = base / project.get("output", {}).get("directory", "output") / out_name
    out_dir.mkdir(parents=True, exist_ok=True)
    logs = []
    for kind in ("satellite", "dem"):
        src = sources.get(kind)
        if not src or src["tiles"].startswith("http"):
            continue
        z = int(src["maxzoom"])
        tpl = src["tiles"]
        xs, ys = [], []
        probe = base / tpl.replace("{z}", str(z)).rsplit("/", 2)[0]
        for xdir in sorted(probe.glob("*")) if probe.exists() else []:
            if xdir.is_dir() and xdir.name.isdigit():
                xs.append(int(xdir.name))
                ys += [int(f.stem) for f in xdir.glob("*") if f.stem.isdigit()]
        if not xs:
            logs.append(f"{kind} z{z}: no tiles found")
            continue
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        ext = tpl.rsplit(".", 1)[-1]
        canvas = Image.new("RGB", ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256), (12, 16, 13))
        missing = 0
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                fp = base / tpl.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
                if fp.exists():
                    canvas.paste(Image.open(fp).convert("RGB"), ((x - x0) * 256, (y - y0) * 256))
                else:
                    missing += 1
        west, north = _tile2deg(x0, y0, z)
        east, south = _tile2deg(x1 + 1, y1 + 1, z)
        stem = f"{'sat' if kind == 'satellite' else 'dem'}_z{z}"
        img_path = out_dir / f"{stem}.{ext if ext in ('jpg', 'png') else 'png'}"
        canvas.save(img_path, quality=94) if img_path.suffix == ".jpg" else canvas.save(img_path)
        (out_dir / f"{stem}.json").write_text(json.dumps({"bounds": [west, south, east, north]}), encoding="utf-8")
        logs.append(f"{kind} z{z}: {x1-x0+1}x{y1-y0+1} tiles -> {img_path.name} ({canvas.size[0]}x{canvas.size[1]}, missing {missing})")
    return logs
