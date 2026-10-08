#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gate_no_private_residue.py — 私货残留硬闸
开源仓不得出现：内网代理 IP / 本机绝对路径 / 主仓名 / 系统字体名（STHeiti/PingFang）。
判例来源：主仓「判例必须沉淀为脚本硬闸」军规；本闸门即抽离工程的验收器。
用法: python3 tests/gates/gate_no_private_residue.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FORBIDDEN = [
    "10.217.142.128",
    "/Users/songchao09",
    "ruyi-studio",
    "STHeiti",
    "PingFang SC",
    "Hiragino Sans GB",
    "playwright-cli",
]
# 允许出现的文件（文档中的「历史叙述」除外白名单：无——文档也不许）
SKIP_DIRS = {".git", "node_modules", ".work", "__pycache__"}
# 豁免：闸门自身（禁忌表所在）；fonts.py 的 ALIASES 块（系统字体名作为「迁移别名」合法存在）
SKIP_FILES = {os.path.abspath(__file__)}
ALLOW_LINES = ("ALIASES", '"STHeiti": "smiley"', '"STHeiti Light": "smiley"',
               '"PingFang SC": "smiley"', '"Hiragino Sans GB": "smiley"', '"Heiti SC": "smiley"',
               '① macOS 系统字体（STHeiti/PingFang）引用在 Linux 全崩')
EXTS = {".py", ".mjs", ".js", ".json", ".md", ".html", ".css", ".toml", ".yml", ".yaml", ".txt"}

fails = []
for base, dirs, files in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for f in files:
        if os.path.splitext(f)[1] not in EXTS:
            continue
        p = os.path.join(base, f)
        if os.path.abspath(p) in SKIP_FILES:
            continue
        try:
            text = open(p, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        for token in FORBIDDEN:
            if token in text:
                for i, line in enumerate(text.splitlines(), 1):
                    if token in line and not any(a in line for a in ALLOW_LINES):
                        fails.append(f"{os.path.relpath(p, ROOT)}:{i} 含 {token!r}: {line.strip()[:90]}")

if fails:
    print("FAIL 私货残留检出：")
    print("\n".join("  " + f for f in fails))
    sys.exit(1)
print(f"PASS 无私货残留（扫描 {len(FORBIDDEN)} 个禁忌 token）")
