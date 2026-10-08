# -*- coding: utf-8 -*-
"""guide_map 阶段二: 总览标注层 + 时刻表面板 (SVG+HTML)
用法: python3 build_overview.py <spec.json> <工作目录> -> final_sat.html, sat_labels.svg
判例: 主图岔口点不带数字(数字只在放大窗/面板); 放大窗内枢纽站可只留徽标; inset-chrome 与 inset 同显隐"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import load_spec, FONT_CSS, col

HALO = "rgba(24,20,14,0.85)"

def badge(x, y, n, color, r=31, fs=33):
    return (f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="{color}" stroke="#fff" stroke-width="5"/>'
            f'<text x="{x:.0f}" y="{y+11:.0f}" font-size="{fs}" font-weight="800" text-anchor="middle" fill="#fff" font-family="RuyiSmiley">{n}</text>')

def label(x, y, t, name, desc, dx, dy, anc, fs=62, ds=34):
    tt = f"{t} {name}" if t else name
    out = (f'<text x="{x+dx:.0f}" y="{y+dy:.0f}" font-size="{fs}" font-weight="800" text-anchor="{anc}" fill="#fff" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="8" paint-order="stroke">{tt}</text>')
    if desc:
        out += (f'<text x="{x+dx:.0f}" y="{y+dy+ds+12:.0f}" font-size="{ds}" text-anchor="{anc}" fill="#F2C879" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="6" paint-order="stroke">{desc}</text>')
    return out

def valley(x, y, deg, text, fs=36):
    return (f'<g class="valley" transform="rotate({deg:.1f} {x:.0f} {y:.0f})">'
            f'<text x="{x:.0f}" y="{y:.0f}" font-size="{fs}" font-weight="600" text-anchor="middle" fill="#fff" '
            f'font-family="RuyiSmiley" letter-spacing="14" opacity="0.62" stroke="{HALO}" stroke-width="5" paint-order="stroke">{text}</text></g>')

def panel_html(spec):
    ov = spec["overview"]; P = ov["panel"]; MAPW = spec["frame"]["mapW"]; CW = spec["frame"]["canvasW"]; CH = spec["frame"]["canvasH"]
    # fontScale: 行标题超宽（长时段前缀如「09:00-11:00」）时缩字号防 l1 换行压下一行（EP9 判例：
    # 42px 下可用宽≈panel宽-130-20，l1 换行使 tg 溢出 row 高 108 与下一行互压；缩到单行放下为止）
    fs = float(P.get("fontScale", 1.0))
    rows_html = []
    n = len(P["rows"])
    top0, step = 226, 108
    if top0 + step*(n-1) + 108 > 1330:   # 行数多时压缩行距
        step = max(84, (1180 - top0) // max(1, n - 1))
    for i, (rn, t, nm, tg, c) in enumerate(P["rows"]):
        top = top0 + i*step
        rows_html.append(
f'''<div class="row" id="tl-{rn}" style="--c:{col(spec,c)};top:{top}px">
<div class="bd">{rn}</div>
<div class="tx"><div class="l1"><span class="tm">{t}</span><span class="nm">{nm}</span></div>
<div class="tg">{tg}</div></div></div>''')
    leg = "".join(f'<div><span class="dot" style="background:{col(spec,l["color"])}"></span>{l["text"]}</div>' for l in P.get("legend", []))
    return f'''<div class="panel">
<div class="p-head">{P["head"]}</div>
<div class="p-sub">{P["sub"]}</div>
<div class="spine" style="top:{top0+36}px;height:{step*(n-1)}px"></div>
{"".join(rows_html)}
<div class="p-leg">{leg}</div>
</div>''', f'''
.panel{{position:absolute;left:{MAPW}px;top:0;width:{CW-MAPW}px;height:{CH}px;
 background:linear-gradient(180deg,rgba(20,22,18,0.96),rgba(29,31,25,0.96));
 border-left:2px solid rgba(255,255,255,0.14);font-family:RuyiSmiley;color:#fff}}
.p-head{{position:absolute;left:56px;top:56px;font-size:52px;font-weight:800;letter-spacing:6px}}
.p-sub{{position:absolute;left:56px;top:138px;font-size:26px;opacity:0.85}}
.spine{{position:absolute;left:79px;width:4px;background:rgba(255,255,255,0.20);border-radius:2px}}
.row{{position:absolute;left:0;width:100%;height:108px;transition:opacity 0.3s}}
.bd{{position:absolute;left:56px;top:22px;width:50px;height:50px;border-radius:50%;background:var(--c);
 color:#fff;font-size:29px;font-weight:800;display:flex;align-items:center;justify-content:center;border:3px solid #fff}}
.tx{{position:absolute;left:130px;top:14px}}
.l1{{white-space:nowrap}}
.l1 .tm{{font-size:{round(42*fs)}px;font-weight:800;margin-right:{round(20*fs)}px}}
.l1 .nm{{font-size:{round(42*fs)}px;font-weight:800}}
.tg{{font-size:{round(25*fs)}px;opacity:0.92;margin-top:8px}}
.row.todo{{opacity:0.28}} .row.todo .tg{{display:none}}
/* EP9 v2 判例（2026-09-27 主人）：收藏卡 s6 态全行=done，旧 done 样式(0.60+空心徽标)把整卡洗灰——
   黑底白字必须清清楚楚，数字徽标填充对应天数背景色（done=已走也要满色满亮，调暗只留给 todo） */
.row.done{{opacity:1.0}} .row.done .bd{{background:var(--c);border-color:#fff}}
.row.current .bd{{box-shadow:0 0 26px var(--c)}}
.row.current .tm{{color:var(--c)}}
.p-leg{{position:absolute;left:56px;bottom:30px;font-size:23px;opacity:0.95;line-height:1.75}}
.p-leg .dot{{display:inline-block;width:16px;height:16px;border-radius:50%;margin-right:12px;vertical-align:-2px}}'''

def main(spec_path, workdir):
    spec = load_spec(spec_path)
    meta = json.load(open(os.path.join(workdir, "sat_meta.json")))
    ov = spec["overview"]
    MAPW = spec["frame"]["mapW"]; CW = spec["frame"]["canvasW"]; CH = spec["frame"]["canvasH"]
    IX, IY, IW, IH = meta["IX"], meta["IY"], meta["IW"], meta["IH"]
    s = [f'<svg width="{CW}" height="{CH}" viewBox="0 0 {CW} {CH}" xmlns="http://www.w3.org/2000/svg">']
    # 岔口覆盖框(极弱)
    pts = " ".join(f"{p[0]:.0f},{p[1]:.0f}" for p in meta["fb_main"])
    s.append(f'<polygon id="coverbox" points="{pts}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="10 8" opacity="0.38"/>')
    # 沟名
    s.append('<g id="valley-names">')
    for v in ov.get("valleyNames", []):
        s.append(valley(v["x"], v["y"], v["deg"], v["text"]))
    s.append('</g>')
    # 主图站点
    for st in ov["mainStops"]:
        if "badgeAt" in st:
            x, y = st["badgeAt"]
        else:
            x, y = meta[st["key"]]
        s.append(f'<g id="stop-{st["n"]}" opacity="1">')
        s.append(badge(x, y, st["n"], col(spec, st["color"])))
        if not st.get("badgeOnly"):  # 枢纽互压区只留徽标（文字让位 inset；判例 10 扩展到主图）
            s.append(label(x, y, st["time"], st["name"], st.get("desc", ""), *st["labelAt"]))
        s.append('</g>')
    # 岔口小点(主图无字)
    for dt in ov.get("dots", []):
        x, y = meta[dt["key"]]
        s.append(f'<g id="mdot-{dt["n"]}" opacity="1">')
        s.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="9" fill="#fff" stroke="rgba(30,30,26,0.6)" stroke-width="2"/>')
        s.append('</g>')
    # 放大窗站点
    for st in ov.get("insetStops", []):
        x, y = meta[st["key"]]
        s.append(f'<g id="istop-{st["n"]}" opacity="1">')
        s.append(badge(x, y, st["n"], col(spec, st["color"]), r=27, fs=29))
        if not st.get("badgeOnly"):
            s.append(label(x, y, st.get("time", ""), st.get("name", ""), st.get("desc", ""), *st["labelAt"], fs=54, ds=31))
        s.append('</g>')
    # 注记
    for nt in ov.get("notes", []):
        x, y = meta[nt["key"]]
        s.append(f'<text id="note-{nt["key"]}" x="{x+nt["dx"]:.0f}" y="{y+nt["dy"]:.0f}" font-size="26" fill="#ddd" text-anchor="{nt.get("anchor","end")}" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="5" paint-order="stroke">{nt["text"]}</text>')
    # chrome: 标题+图例
    s.append('<g id="chrome">')
    s.append(f'<text x="84" y="120" font-size="66" font-weight="800" fill="#fff" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="10" paint-order="stroke">{ov["title"]}</text>')
    if ov.get("subtitle"):
        s.append(f'<text x="84" y="170" font-size="29" fill="#fff" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="5" paint-order="stroke" opacity="0.95">{ov["subtitle"]}</text>')
    lx0, ly0 = 88, 214
    for i, lg in enumerate(ov.get("legend", [])):
        x = lx0 + i*190
        if lg["kind"] == "bus":
            s.append(f'<line x1="{x}" y1="{ly0}" x2="{x+56}" y2="{ly0}" stroke="#5e4e3a" stroke-width="9" stroke-linecap="round"/>')
        else:
            s.append(f'<line x1="{x}" y1="{ly0}" x2="{x+56}" y2="{ly0}" stroke="#fff" stroke-width="6" stroke-dasharray="10 9" stroke-linecap="round"/>')
        s.append(f'<text x="{x+70}" y="{ly0+9}" font-size="25" fill="#fff" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="5" paint-order="stroke">{lg["label"]}</text>')
    s.append('</g>')
    # 放大窗框+签
    s.append('<g id="inset-chrome">')
    s.append(f'<rect x="{IX-8}" y="{IY-8}" width="{IW+16}" height="{IH+16}" rx="12" fill="none" stroke="#fff" stroke-width="5"/>')
    s.append(f'<rect x="{IX+16}" y="{IY-30}" width="300" height="44" rx="8" fill="rgba(24,20,14,0.85)"/>')
    s.append(f'<text x="{IX+32}" y="{IY+1}" font-size="26" font-weight="700" fill="#fff" font-family="RuyiSmiley">{spec["inset"]["chrome"]}</text>')
    s.append('</g>')
    # S6 收藏横幅
    if ov.get("s6Banner"):
        b = ov["s6Banner"]
        bx, by = b.get("at", [90, 240])  # EP10 判例：banner 默认左上压核心内容——可配置，EP10 置底部
        s.append('<g id="s6-banner" opacity="0">')
        s.append(f'<rect x="{bx}" y="{by}" width="860" height="130" rx="16" fill="rgba(20,18,14,0.82)"/>')
        s.append(f'<text x="{bx+430}" y="{by+56}" font-size="44" font-weight="800" text-anchor="middle" fill="#F2C879" font-family="RuyiSmiley">{b["title"]}</text>')
        s.append(f'<text x="{bx+430}" y="{by+102}" font-size="24" text-anchor="middle" fill="#cfc9bd" font-family="RuyiSmiley">{b["sub"]}</text>')
        s.append('</g>')
    s.append('</svg>')
    open(os.path.join(workdir, "sat_labels.svg"), "w").write("\n".join(s))
    panel, panel_css = panel_html(spec)
    html = f'''<!DOCTYPE html><html><head><meta charset="utf-8"><style>
{FONT_CSS}
body{{margin:0;width:{CW}px;height:{CH}px;position:relative;background:#22241f}}
img.base{{position:absolute;left:0;top:0}}
img.inset{{position:absolute;left:{IX}px;top:{IY}px;border-radius:6px;box-shadow:0 6px 30px rgba(0,0,0,0.5)}}
svg{{position:absolute;left:0;top:0}}
{panel_css}
</style></head><body>
<img class="base" src="sat_frame.png"/>
<img class="inset" src="sat_inset.png"/>
{open(os.path.join(workdir, "sat_labels.svg")).read()}
{panel}
</body></html>'''
    open(os.path.join(workdir, "final_sat.html"), "w").write(html)
    print("build_overview ok")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
