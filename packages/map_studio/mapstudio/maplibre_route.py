#!/usr/bin/env python3
"""Map Studio v2 MapLibre 3D 路线渲染编排：preview / render-route / qa-render。

渲染器只消费 output/compiled.json；本模块负责编译、起本地服务、驱动
playwright 逐帧渲染、ffmpeg 编码与交付前 QA，不含任何景区专属逻辑。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from compiler import compile_project  # noqa: E402
from serve import start_server  # noqa: E402

WEB = HERE / "web"
QUALITY = {
    "rough": {"width": 1280, "height": 720, "scale": 1, "crf": "21"},
    # final=恒定 1280x720 逻辑视口+dsf3 超采样出 3840x2160（2026-09-11 判例：旧档 width 3840+scale 3
    # =视口 3840×dsf3=11520x6480 帧，SwiftShader 必崩；width/height 是视口不是输出）
    "final": {"width": 1280, "height": 720, "scale": 3, "crf": "18"},
}


def _node() -> str:
    node = shutil.which("node")
    if not node:
        raise ValueError("node not found in PATH")
    return node


def _run_render(url: str, out_dir: Path, duration: float, fps: int, quality: dict, at: float | None,
                query: str = "") -> Path:
    report = out_dir / "render_report.json"
    cmd = [_node(), str(WEB / "render.mjs"), "--url", url, "--out", str(out_dir),
           "--duration", str(duration), "--fps", str(fps), "--report", str(report),
           "--width", str(quality["width"]), "--height", str(quality["height"]),
           "--scale", str(quality["scale"])]
    if query:  # 透传 renderer.html query（legend=0 等；EP6 川西 v2 pill 全灭判例 2026-09-17）
        cmd += ["--q", query]
    if at is not None:
        cmd += ["--at", str(at)]
    subprocess.run(cmd, check=True)
    return report


def _compiled(project_path: Path) -> tuple[dict, Path]:
    return compile_project(project_path)


def preview(project_path: Path, at: float) -> Path:
    compiled, _ = _compiled(project_path)
    base = project_path.resolve().parent
    server, port = start_server(base)
    try:
        out_dir = base / compiled["output"].get("directory", "output") / "preview"
        _run_render(f"http://127.0.0.1:{port}", out_dir, compiled["storyboard"]["durationSeconds"],
                    compiled["output"]["fps"], QUALITY["rough"], at,
                    compiled["output"].get("query", ""))
        return out_dir / f"preview-{at}.png"
    finally:
        server.shutdown()


def render_route(project_path: Path, quality_name: str, keep_frames: bool = False) -> Path:
    if quality_name not in QUALITY:
        raise ValueError(f"unknown quality: {quality_name} (rough|final)")
    quality = QUALITY[quality_name]
    compiled, _ = _compiled(project_path)
    base = project_path.resolve().parent
    out_root = base / compiled["output"].get("directory", "output")
    frames_dir = out_root / f"frames_{quality_name}"
    server, port = start_server(base)
    try:
        report = _run_render(f"http://127.0.0.1:{port}", frames_dir, compiled["storyboard"]["durationSeconds"],
                             compiled["output"]["fps"], quality, None,
                             compiled["output"].get("query", ""))
    finally:
        server.shutdown()
    info = json.loads(report.read_text(encoding="utf-8"))
    if info.get("errors"):
        raise ValueError(f"renderer reported errors: {info['errors']}")
    shutil.copy2(report, out_root / f"render_report_{quality_name}.json")
    fps = compiled["output"]["fps"]
    width, height = quality["width"] * quality["scale"], quality["height"] * quality["scale"]
    out_mp4 = out_root / f"{compiled['name']}-{quality_name}-{width}x{height}.mp4"
    subprocess.run(["ffmpeg", "-y", "-framerate", str(fps), "-i", str(frames_dir / "f%04d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", quality["crf"],
                    "-movflags", "+faststart", str(out_mp4)], check=True, capture_output=True)
    if not keep_frames:
        shutil.rmtree(frames_dir, ignore_errors=True)
    return out_mp4


def qa_render(project_path: Path, quality_name: str = "rough") -> list[str]:
    """交付前自动 QA：帧数、缺瓦片、渲染错误、overlay 安全区、黑闪。返回错误列表。"""
    compiled, _ = _compiled(project_path)
    base = project_path.resolve().parent
    out_root = base / compiled["output"].get("directory", "output")
    errors: list[str] = []
    quality = QUALITY.get(quality_name, QUALITY["rough"])
    width, height = quality["width"] * quality["scale"], quality["height"] * quality["scale"]

    report_path = out_root / f"render_report_{quality_name}.json"
    candidates = sorted(out_root.glob(f"{compiled['name']}-{quality_name}-*.mp4"))
    if not candidates:
        errors.append(f"missing rendered mp4 for quality {quality_name}")
    else:
        mp4 = candidates[-1]
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
                                "-show_entries", "stream=nb_read_frames,width,height", "-of", "json", str(mp4)],
                               text=True, capture_output=True)
        meta = json.loads(probe.stdout or "{}").get("streams", [{}])[0]
        expect = round(compiled["storyboard"]["durationSeconds"] * compiled["output"]["fps"])
        if int(meta.get("nb_read_frames", 0)) != expect:
            errors.append(f"frame count {meta.get('nb_read_frames')} != {expect}")
        if (int(meta.get("width", 0)), int(meta.get("height", 0))) != (width, height):
            errors.append(f"video size {meta.get('width')}x{meta.get('height')} != {width}x{height}")
        black = subprocess.run(["ffmpeg", "-i", str(mp4), "-vf", "blackdetect=d=0.12:pix_th=0.10",
                                "-an", "-f", "null", "-"], text=True, capture_output=True)
        hits = [ln for ln in black.stderr.splitlines() if "blackdetect" in ln and "black_start" in ln]
        if hits:
            errors.append("black flash detected: " + hits[0].strip())

    missing = out_root / "tile_missing.log"
    if missing.exists() and missing.read_text(encoding="utf-8").strip():
        lines = missing.read_text(encoding="utf-8").split()
        errors.append(f"missing tiles: {len(lines)} (first: {lines[0]})")

        # 相邻帧跳变扫描（防抖三件套的机器化：瓦片跳/相机跳都表现为单帧内容突变）。
        # 4fps 缩样，相邻帧平均绝对差 > 阈值即报——转场/hold 切换处允许一次，连续多次或超阈值 2 倍算错。
        jumps = frame_jumps(mp4, fps_sample=4, threshold=28.0)
        if jumps:
            errors.append(f"frame jumps ×{len(jumps)} (t≈{', '.join(f'{t:.1f}' for t, _ in jumps[:6])})——瓦片级别混用/相机急冲，见 FOLLOW_ROUTE_GUIDE 防抖三件套")

    if report_path.exists():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        noise = ("Failed to load resource", "favicon")
        real_errors = [e for e in report.get("errors", "").split(";") if e.strip() and not any(n in e for n in noise)]
        if real_errors:
            errors.append(f"renderer __ERR: {';'.join(real_errors)}")
        if report.get("idleTimeouts"):
            errors.append(f"idle timeouts at: {report['idleTimeouts'][:5]}")
        margin = 16 * quality["scale"]
        for snap in report.get("overlays", []):
            for item in snap.get("items", []):
                r = item["rect"]
                x0, y0 = r["x"] * quality["scale"], r["y"] * quality["scale"]
                x1, y1 = x0 + r["w"] * quality["scale"], y0 + r["h"] * quality["scale"]
                if x0 < margin or y0 < margin or x1 > width - margin or y1 > height - margin:
                    errors.append(f"overlay out of safe area at t={snap['t']}: {item['kind']} {item['text']!r}")
    return errors


def frame_jumps(mp4: Path, fps_sample: int = 4, threshold: float = 28.0) -> list[tuple[float, float]]:
    """相邻采样帧平均绝对差（0–255 灰度）超阈值的时刻列表。低分辨率缩样，不逐帧全分辨率比对。"""
    import tempfile
    from PIL import Image, ImageChops
    out: list[tuple[float, float]] = []
    with tempfile.TemporaryDirectory() as td:
        r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(mp4), "-vf", f"fps={fps_sample},scale=160:-1",
                            str(Path(td) / "%05d.png")], capture_output=True, text=True)
        if r.returncode != 0:
            return out
        frames = sorted(Path(td).glob("*.png"))
        prev = None
        for i, f in enumerate(frames):
            cur = Image.open(f).convert("L")
            if prev is not None:
                diff = ImageChops.difference(cur, prev)
                hist = diff.histogram()
                n = sum(hist)
                mean = sum(k * c for k, c in enumerate(hist)) / n if n else 0.0
                if mean > threshold:
                    out.append((i / fps_sample, mean))
            prev = cur
    return out


def audit_route(project_path: Path, zoom: int | None = None) -> Path:
    """轨迹品红叠加目检图（FOLLOW_ROUTE_GUIDE §2.2 定罪标准）：stitch 卫星大图 → 按 geoSidecar 投影
    把 routes 全段画品红，段首绿点 / 段末红圈（中段贴路好≠末段好——bus-elevator 末段横穿山坡判例）。
    产物 <project>/output/route_audit_z<Z>.png，人工 Read 目检。"""
    from PIL import Image, ImageDraw
    from tiles import stitch_tiles
    project_path = project_path.resolve()
    base = project_path.parent
    stitch_tiles(project_path)
    compiled, _ = _compiled(project_path)
    out_root = base / compiled["output"].get("directory", "output")
    src_dir = out_root / "prepared-src"
    cands = sorted(list(src_dir.glob("sat_z*.jpg")) + list(src_dir.glob("sat_z*.png")), key=lambda f: f.stat().st_mtime)
    if not cands:
        raise ValueError(f"stitch 未产出 sat_z*（{src_dir}）——先 fetch-tiles")
    img_path = cands[-1]
    meta = json.loads(img_path.with_suffix(".json").read_text(encoding="utf-8"))
    west, south, east, north = meta["bounds"]
    img = Image.open(img_path).convert("RGB")
    W, H = img.size
    draw = ImageDraw.Draw(img)

    def proj(pt):
        return (pt[0] - west) / (east - west) * W, (north - pt[1]) / (north - south) * H

    for seg in compiled["segments"]:
        coords = seg.get("coordinates") or []
        if len(coords) < 2:
            continue
        pts = [proj(c) for c in coords]
        draw.line(pts, fill=(255, 0, 220), width=4)
        draw.ellipse([pts[0][0] - 8, pts[0][1] - 8, pts[0][0] + 8, pts[0][1] + 8], fill=(0, 255, 120))
        draw.ellipse([pts[-1][0] - 10, pts[-1][1] - 10, pts[-1][0] + 10, pts[-1][1] + 10], outline=(255, 40, 40), width=4)
    z = zoom or meta.get("zoom") or int(str(img_path.stem).split("_z")[-1])
    out = out_root / f"route_audit_z{z}.png"
    img.save(out)
    return out
