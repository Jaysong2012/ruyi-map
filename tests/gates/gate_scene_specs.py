#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gate_scene_specs.py — scene3d spec 硬闸
规则（判例沉淀）：
  1. terrain_block/flood_block/huashan_sun/weihe_*/jilong_flyover 必须显式 params.base（无内置默认数据）
  2. terrain_block exaggeration>30 警告（28=可信高墙档，45=刀片墙判死）
  3. terrain_block routes:true 必须齐 wps/flight/origin/airport/finale 五件套
  4. spec.out 不得指向仓外绝对路径
用法: python3 tests/gates/gate_scene_specs.py [spec.json ...]（缺省扫 examples/ 全部 scene3d spec）
"""
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NEED_BASE = {"terrain_block", "flood_block", "huashan_sun", "weihe_valley", "weihe_erosion", "jilong_flyover"}
ROUTE_KEYS = ["wps", "flight", "origin", "airport", "finale"]

specs = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT, "examples", "**", "*.json"), recursive=True))
fails, warns, checked = [], [], 0
for path in specs:
    try:
        d = json.load(open(path))
    except Exception:
        continue
    if "program" not in d:   # 非 scene3d spec
        continue
    checked += 1
    rel = os.path.relpath(path, ROOT)
    prog, params = d["program"], d.get("params", {})
    if prog in NEED_BASE and not params.get("base"):
        fails.append(f"{rel}: {prog} 缺 params.base")
    if prog == "terrain_block":
        ex = params.get("exaggeration")
        if ex and ex > 30:
            warns.append(f"{rel}: exaggeration={ex}>30（28=可信档，45=刀片墙判死）")
        if params.get("routes"):
            missing = [k for k in ROUTE_KEYS if k not in params]
            if missing:
                fails.append(f"{rel}: routes:true 缺 {missing}")
    out = d.get("out", "")
    if out.startswith("/") and not out.startswith(ROOT):
        fails.append(f"{rel}: out 指向仓外 {out}")

for w in warns:
    print("WARN", w)
if fails:
    print("FAIL"); print("\n".join("  " + f for f in fails)); sys.exit(1)
print(f"PASS scene3d spec 硬闸（{checked} 份 spec，{len(warns)} 警告）")
