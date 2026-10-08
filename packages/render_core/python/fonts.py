#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""render_core/python/fonts.py — 打包字体注册表（OFL，随仓分发）

消灭两类历史事故：① macOS 系统字体（STHeiti/PingFang）引用在 Linux 全崩；
② 硬编码 /System/Library/Fonts 绝对路径。所有渲染一律走本注册表。

用法：
    from fonts import font_path, pil_font, font_face_css
    f = pil_font("zcool", 64)                 # PIL ImageFont
    css = font_face_css("/__ruyi_assets__/fonts/")   # 注入 HTML/SVG 的 @font-face
"""
from pathlib import Path

FONTS_DIR = Path(__file__).resolve().parents[3] / "assets" / "fonts"

# 角色 → 文件。选角原则：中文标题=zcool（黄油体，hero 标题/大数字）；
# 中文正文/标签=smiley（得意黑，屏显优化）；中文手写/文艺=wenkai（文楷）/mashan（毛笔）；
# 西文数字/时刻表=grotesk（Space Grotesk 等宽感）。
REGISTRY = {
    "zcool":   "ZCOOLQingKeHuangYou-Regular.ttf",
    "smiley":  "SmileySans-Oblique.ttf",
    "wenkai":  "LXGWWenKai-Regular.ttf",
    "wenkai-m": "LXGWWenKai-Medium.ttf",
    "mashan":  "MaShanZheng-Regular.ttf",
    "grotesk": "SpaceGrotesk.ttf",
}

# 历史引用别名 → 注册表角色（迁移期兼容，新代码禁止用系统字体名）
ALIASES = {
    "STHeiti": "smiley", "STHeiti Light": "smiley", "PingFang SC": "smiley",
    "Hiragino Sans GB": "smiley", "Heiti SC": "smiley",
}


def font_path(role: str) -> Path:
    """角色或别名字 → ttf 绝对路径。未知名直接报错，不静默回退系统字体。"""
    role = ALIASES.get(role, role)
    if role not in REGISTRY:
        raise KeyError(f"未知字体角色 {role!r}，可选：{sorted(REGISTRY)}（或别名 {sorted(ALIASES)}）")
    p = FONTS_DIR / REGISTRY[role]
    if not p.is_file():
        raise FileNotFoundError(f"字体文件缺失 {p}——请确认 assets/fonts/ 完整")
    return p


def pil_font(role: str, size: int):
    from PIL import ImageFont
    return ImageFont.truetype(str(font_path(role)), size)


def font_face_css(url_prefix: str) -> str:
    """生成 @font-face 块。url_prefix 例：'assets/fonts/'（file:// 相对）或
    '/__ruyi_assets__/fonts/'（render_core 静态服务前缀）。"""
    fam = {"zcool": "RuyiZcool", "smiley": "RuyiSmiley", "wenkai": "RuyiWenKai",
           "wenkai-m": "RuyiWenKaiM", "mashan": "RuyiMashan", "grotesk": "RuyiGrotesk"}
    return "\n".join(
        f"@font-face{{font-family:'{fam[r]}';src:url('{url_prefix}{fn}') format('truetype');}}"
        for r, fn in REGISTRY.items())


# CSS font-family 速查（font_face_css 注入后可用）
CSS_FAMILY = {
    "zcool": "'RuyiZcool',sans-serif",
    "smiley": "'RuyiSmiley',sans-serif",
    "wenkai": "'RuyiWenKai',sans-serif",
    "wenkai-m": "'RuyiWenKaiM',sans-serif",
    "mashan": "'RuyiMashan',serif",
    "grotesk": "'RuyiGrotesk',monospace",
}

if __name__ == "__main__":
    for role in REGISTRY:
        print(f"{role:10s} {font_path(role)}")
