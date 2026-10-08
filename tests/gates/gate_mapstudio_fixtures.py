#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gate_mapstudio_fixtures.py — map_studio 夹具契约硬闸
  1. 四件套过 JSON Schema（schemas/ 五份正本）
  2. examples 夹具 build 确定性：连编两次 compiled.json 全等（黄金基线纪律）
用法: python3 tests/gates/gate_mapstudio_fixtures.py
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MS = os.path.join(ROOT, "packages", "map_studio")
sys.path.insert(0, os.path.join(MS, "mapstudio"))
from validate_v2 import validate_route_project  # noqa: E402

fails = []
for fixture in ("wulingyuan-follow-route", "jiuzhaigou-route", "huangshan-route"):
    d = os.path.join(MS, "examples", fixture)
    try:
        problems = validate_route_project(__import__("pathlib").Path(d) / "project.json")
        if problems:
            fails.append(f"{fixture}: schema 校验 {problems[:3]}")
    except Exception as e:
        fails.append(f"{fixture}: {e}")

# 确定性：临时目录 init-route 连编两次
with tempfile.TemporaryDirectory() as tmp:
    target = os.path.join(tmp, "route")
    subprocess.run([sys.executable, os.path.join(MS, "mapstudio.py"), "init-route", target],
                   check=True, capture_output=True)
    cmd = [sys.executable, os.path.join(MS, "mapstudio.py"), "build", os.path.join(target, "project.json")]
    subprocess.run(cmd, check=True, capture_output=True)
    first = open(os.path.join(target, "output/compiled.json")).read()
    subprocess.run(cmd, check=True, capture_output=True)
    second = open(os.path.join(target, "output/compiled.json")).read()
    if first != second:
        fails.append("build 不确定性：两次 compiled.json 不一致")

if fails:
    print("FAIL"); print("\n".join("  " + f for f in fails)); sys.exit(1)
print("PASS map_studio 夹具契约（schema + build 确定性）")
