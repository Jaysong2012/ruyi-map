#!/usr/bin/env python3
"""Map Studio command line entry point. Standard library only."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "mapstudio"))
from compiler import compile_project, qa_compiled
from maplibre_route import preview as route_preview, render_route, qa_render, audit_route
from tiles import fetch_tiles, stitch_tiles, build_pyramid
from validate_v2 import validate_route_project

ROOT = Path(__file__).resolve().parent
REQUIRED = {"schemaVersion", "name", "bounds", "sources", "look", "shots", "output"}


def load_scene(path: Path) -> dict:
    scene = json.loads(path.read_text(encoding="utf-8"))
    missing = REQUIRED - scene.keys()
    if missing:
        raise ValueError(f"missing fields: {', '.join(sorted(missing))}")
    if scene["schemaVersion"] != 1:
        raise ValueError("unsupported schemaVersion")
    west, south, east, north = scene["bounds"]
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("bounds must be [west, south, east, north]")
    if not scene["shots"]:
        raise ValueError("shots must not be empty")
    return scene


def cmd_init(target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    (target / "data").mkdir(exist_ok=True)
    sample = json.loads((ROOT / "examples/huangshan/scene.json").read_text())
    sample["name"] = target.name
    (target / "scene.json").write_text(json.dumps(sample, ensure_ascii=False, indent=2) + "\n")
    print(f"READY {target / 'scene.json'}")


def cmd_init_route(target: Path) -> None:
    """新路线工程脚手架：抄标准案例 wulingyuan-follow-route（主人终审通过的跟拍模式），不是旧黄山工程。"""
    if target.exists() and any(target.iterdir()):
        raise ValueError(f"target is not empty: {target}")
    shutil.copytree(ROOT / "examples/wulingyuan-follow-route", target, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("data", "output", "__pycache__", "*.bak*", "*_clean*"))
    (target / "output").mkdir(exist_ok=True)
    print(f"READY {target / 'project.json'}")


def cmd_validate(path: Path) -> None:
    scene = load_scene(path)
    base = path.parent
    missing = []
    for value in scene["sources"].values():
        values = [value] if isinstance(value, str) else [value["path"], value.get("geoSidecar")]
        missing.extend(str(base / x) for x in values if x and not (base / x).exists())
    print(f"OK schema: {scene['name']} ({len(scene['shots'])} shots)")
    if missing:
        print("WAITING source files:")
        for item in missing:
            print(f"  {item}")


def cmd_doctor() -> None:
    tools = {"blender": ["blender", "/Applications/Blender.app/Contents/MacOS/Blender"],
             "gdal_translate": ["gdal_translate"], "oiiotool": ["oiiotool"], "ffmpeg": ["ffmpeg"]}
    for name, candidates in tools.items():
        found = next((shutil.which(x) or (x if Path(x).exists() else None) for x in candidates), None)
        print(f"{'OK' if found else 'OPTIONAL'} {name}: {found or 'not installed'}")


def cmd_prepare(path: Path) -> None:
    scene = load_scene(path)
    subprocess.run([sys.executable, str(ROOT / "mapstudio/prepare.py"), str(path)], check=True)


def cmd_render(path: Path, still: str) -> None:
    load_scene(path)
    blender = shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"
    if not Path(blender).exists():
        raise SystemExit("Blender backend unavailable; run doctor and install Blender only when rendering is needed")
    subprocess.run([blender, "--background", "--python", str(ROOT / "mapstudio/blender_scene.py"), "--", str(path), still], check=True)


def cmd_build(path: Path) -> None:
    compiled, out = compile_project(path)
    print(f"BUILT {compiled['name']} {compiled['build']['contractSha256']} -> {out}")


def cmd_qa(path: Path) -> None:
    compiled, out = compile_project(path)
    errors = qa_compiled(compiled)
    if errors:
        raise ValueError("; ".join(errors))
    print(f"OK route QA: {len(compiled['segments'])} segments, {len(compiled['storyboard']['events'])} events -> {out}")


def cmd_fetch_tiles(path: Path, corridor: bool, pad: float, zooms: str | None) -> None:
    zs = [int(z) for z in zooms.split(",")] if zooms else None
    for line in fetch_tiles(path, corridor=corridor, corridor_pad_deg=pad, zooms=zs):
        print(f"OK {line}")


def cmd_audit_route(path: Path, zoom: int | None) -> None:
    print(f"AUDIT {audit_route(path, zoom)}  ← Read 目检：品红贴路？段首绿点/段末红圈落在真实路口？")


def cmd_validate_route(path: Path) -> None:
    problems = validate_route_project(path)
    if problems:
        raise ValueError("; ".join(problems))
    compiled, out = compile_project(path)
    errors = qa_compiled(compiled)
    # 「segments never shown」是数据卫生问题（同一 routes 供多份 storyboard 复用是合法用法），WARN 不 FAIL
    warns = [e for e in errors if e.startswith("segments never shown")]
    errors = [e for e in errors if e not in warns]
    if errors:
        raise ValueError("; ".join(errors))
    for w in warns:
        print(f"WARN {w}")
    print(f"OK validate-route: schema×4 + compile + qa → {compiled['name']} ({len(compiled['segments'])} segments, {len(compiled['storyboard']['events'])} events)")


def cmd_stitch(path: Path) -> None:
    for line in stitch_tiles(path):
        print(f"OK {line}")


def cmd_pyramid(path: Path) -> None:
    for line in build_pyramid(path):
        print(f"OK {line}")


def cmd_preview(path: Path, at: float) -> None:
    print(f"READY {route_preview(path, at)}")


def cmd_render_route(path: Path, quality: str, keep_frames: bool) -> None:
    print(f"RENDERED {render_route(path, quality, keep_frames)}")


def cmd_qa_render(path: Path, quality: str) -> None:
    errors = qa_render(path, quality)
    if errors:
        raise ValueError("; ".join(errors))
    print(f"OK render QA ({quality})")


ap = argparse.ArgumentParser(description="Spec-driven cinematic map renderer")
sub = ap.add_subparsers(dest="command", required=True)
p = sub.add_parser("init"); p.add_argument("directory", type=Path)
p = sub.add_parser("init-route"); p.add_argument("directory", type=Path)
p = sub.add_parser("validate"); p.add_argument("scene", type=Path)
sub.add_parser("doctor")
p = sub.add_parser("prepare"); p.add_argument("scene", type=Path)
p = sub.add_parser("render"); p.add_argument("scene", type=Path); p.add_argument("--still", required=True)
p = sub.add_parser("build"); p.add_argument("project", type=Path)
p = sub.add_parser("qa"); p.add_argument("project", type=Path)
p = sub.add_parser("fetch-tiles"); p.add_argument("project", type=Path)
p.add_argument("--corridor", action="store_true", help="只抓 routes 走廊（高 z 级补抓；全区域 >4000 张被跳过的解法）")
p.add_argument("--pad", type=float, default=0.02, help="走廊外扩（度）"); p.add_argument("--zooms", help="逗号分隔级别，默认 maxzoom-1,maxzoom")
p = sub.add_parser("audit-route"); p.add_argument("project", type=Path); p.add_argument("--zoom", type=int)
p = sub.add_parser("validate-route"); p.add_argument("project", type=Path)
p = sub.add_parser("stitch"); p.add_argument("project", type=Path)
p = sub.add_parser("pyramid"); p.add_argument("project", type=Path)
p = sub.add_parser("preview"); p.add_argument("project", type=Path); p.add_argument("--at", type=float, required=True)
p = sub.add_parser("render-route"); p.add_argument("project", type=Path); p.add_argument("--quality", default="rough", choices=["rough", "final"]); p.add_argument("--keep-frames", action="store_true")
p = sub.add_parser("qa-render"); p.add_argument("project", type=Path); p.add_argument("--quality", default="rough", choices=["rough", "final"])
a = ap.parse_args()
try:
    {"init": lambda: cmd_init(a.directory), "init-route": lambda: cmd_init_route(a.directory),
     "validate": lambda: cmd_validate(a.scene),
     "doctor": cmd_doctor, "prepare": lambda: cmd_prepare(a.scene),
     "render": lambda: cmd_render(a.scene, a.still),
     "build": lambda: cmd_build(a.project), "qa": lambda: cmd_qa(a.project),
     "fetch-tiles": lambda: cmd_fetch_tiles(a.project, a.corridor, a.pad, a.zooms),
     "audit-route": lambda: cmd_audit_route(a.project, a.zoom),
     "validate-route": lambda: cmd_validate_route(a.project),
     "stitch": lambda: cmd_stitch(a.project),
     "pyramid": lambda: cmd_pyramid(a.project),
     "preview": lambda: cmd_preview(a.project, a.at),
     "render-route": lambda: cmd_render_route(a.project, a.quality, a.keep_frames),
     "qa-render": lambda: cmd_qa_render(a.project, a.quality)}[a.command]()
except (ValueError, json.JSONDecodeError) as exc:
    raise SystemExit(f"INVALID: {exc}")
