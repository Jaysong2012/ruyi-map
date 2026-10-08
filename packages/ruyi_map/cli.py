#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ruyi-map 统一命令行入口：ruyi-map <管线> <命令> [参数...]

管线路由：
  route  → map_studio 3D 攻略路线（init-route/build/render-route/qa-render/fetch-tiles/preview/...）
  still  → map_studio Blender 自然地形定帧（init/prepare/render/doctor）
  bake   → geo_bake 2D 地理事件（map/cloud/event/himawari）
  scene  → scene3d 3D 程序场景（render/fetch-terrain）
  guide  → guide_map 时刻表攻略地图（run/fetch-tiles）
  html   → render_core 通用 HTML 动画渲染（render）
  check  → QA 闸门注册表全量跑（tests/gates/）
  doctor → 环境自检（node/chromium/ffmpeg/blender/字体）
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # 仓根（packages/ruyi_map/ 上两级）
PKG = os.path.join(ROOT, "packages")


def py(script): return [sys.executable, os.path.join(PKG, script)]


ROUTES = {
    "route": lambda a: py("map_studio/mapstudio.py") + a,
    "still": lambda a: py("map_studio/mapstudio.py") + a,
    "bake":  lambda a: _bake(a),
    "scene": lambda a: _scene(a),
    "guide": lambda a: _guide(a),
    "html":  lambda a: _html(a),
    "check": lambda a: _check(a),
    "doctor": lambda a: _doctor(),
}


def _bake(a):
    if not a:
        return ["echo", "bake 子命令: map/cloud/event/himawari"]
    sub, rest = a[0], a[1:]
    m = {
        "map": py("geo_bake/map_bake.py"),
        "cloud": py("geo_bake/cloud_bake.py"),
        "event": py("geo_bake/map_event_renderer.py"),
        "himawari": py("geo_bake/himawari_mosaic.py"),
    }
    if sub not in m:
        sys.exit(f"未知 bake 子命令 {sub}（可选 {sorted(m)}）")
    return m[sub] + rest


def _scene(a):
    if not a:
        return ["echo", "scene 子命令: render/fetch-terrain"]
    sub, rest = a[0], a[1:]
    if sub == "render":
        return ["node", os.path.join(PKG, "scene3d/render_scene.mjs")] + rest
    if sub == "fetch-terrain":
        return py("scene3d/fetch_terrain_block.py") + rest
    sys.exit(f"未知 scene 子命令 {sub}（render/fetch-terrain）")


def _guide(a):
    if not a:
        return ["echo", "guide 子命令: run/fetch-tiles"]
    sub, rest = a[0], a[1:]
    if sub == "run":
        return py("guide_map/run_pipeline.py") + rest
    if sub == "fetch-tiles":
        return py("guide_map/fetch_sat_tiles.py") + rest
    sys.exit(f"未知 guide 子命令 {sub}（run/fetch-tiles）")


def _html(a):
    if a and a[0] == "render":
        return ["node", os.path.join(PKG, "render_core/node/render_html.mjs")] + a[1:]
    return ["echo", "html 子命令: render <spec.json>"]


def _check(a):
    gates = os.path.join(ROOT, "tests", "gates")
    scripts = sorted(f for f in os.listdir(gates) if f.endswith(".py")) if os.path.isdir(gates) else []
    if not scripts:
        return ["echo", "tests/gates/ 暂无闸门脚本"]
    fails = []
    for g in scripts:
        print(f"── gate: {g}")
        r = subprocess.run([sys.executable, os.path.join(gates, g)] + a, cwd=ROOT)
        if r.returncode != 0:
            fails.append(g)
    if fails:
        sys.exit(f"✗ 闸门未过: {fails}")
    return ["echo", "✔ 全部闸门通过"]


def _doctor():
    print("ruyi-map 环境自检")
    ok = True
    for name, cmd in [("node", ["node", "--version"]),
                      ("ffmpeg", ["ffmpeg", "-version"]),
                      ("ffprobe", ["ffprobe", "-version"]),
                      ("blender (可选，still 管线)", ["blender", "--version"])]:
        found = shutil.which(cmd[0])
        print(f"  {'✔' if found else '✗'} {name}: {found or '未找到'}")
        if not found and "可选" not in name:
            ok = False
    try:
        r = subprocess.run(["node", "-e",
                            f"import('{PKG}/render_core/node/chromium.mjs').then(m=>console.log(m.chromiumPath()||'default'))"],
                           capture_output=True, text=True, cwd=ROOT)
        print(f"  {'✔' if r.returncode == 0 else '✗'} chromium: {r.stdout.strip() or r.stderr.strip()[:120]}")
        if r.returncode != 0:
            ok = False
    except Exception as e:
        print(f"  ✗ chromium 解析失败: {e}")
        ok = False
    fonts = os.path.join(ROOT, "assets", "fonts", "SmileySans-Oblique.ttf")
    fonts_ok = os.path.exists(fonts)
    print(f"  {'✔' if fonts_ok else '✗'} 打包字体: {fonts}")
    ok = ok and fonts_ok
    sys.exit(0 if ok else 1)


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    pipe, rest = sys.argv[1], sys.argv[2:]
    if pipe not in ROUTES:
        sys.exit(f"未知管线 {pipe}（可选 {sorted(ROUTES)}）")
    cmd = ROUTES[pipe](rest)
    raise SystemExit(subprocess.call(cmd, cwd=ROOT))


if __name__ == "__main__":
    main()
