# -*- coding: utf-8 -*-
"""guide_map 阶段三: 区域 beat (底图 PNG + 标注 HTML)
用法: python3 build_beats.py <spec.json> <工作目录> -> beat_<name>.png/.html + beat_meta_<name>.json
判例: ROTATE_90 坐标映射用旋转前宽度(cw0); 目标偏置取景 clamp; 水面恒定 3px 白边矢量重画;
      走过=灰绿/当前=金(车实线/步行金壳白芯虚线)/未走=计划线"""
import json, math, os, sys
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(__file__))
from common import load_spec, FONT_CSS, proj_of, load_locs, ll_of, projector, seg_pts, cut, chaikin, draw_dash, col, col_rgb
from build_overview import panel_html, HALO, badge as svg_badge

def main(spec_path, workdir):
    spec = load_spec(spec_path)
    img = Image.open(os.path.join(workdir, "sat_clean.png")).convert("RGB")
    ll2c = projector(spec, img.size)
    locs = load_locs(spec)
    BUS = spec["routes"]["bus"]
    RAWGEO = {k: v for k, v in spec["routes"].get("rawGeo", {}).items()}
    ALLSEG = {**BUS, **RAWGEO}   # EP10 起：坐标折线链与站点链同 namespace（rawGeo 首用）
    def resolve(keys):
        # rawGeo dict 取坐标链；坐标链直接用（真实路网点密不需 chaikin）；站点 id 链走 seg_pts
        if isinstance(keys, dict):
            keys = keys["coordinates"]
        if keys and isinstance(keys[0], (list, tuple)):
            return [ll2c(*c) for c in keys]
        return seg_pts(keys, locs, ll2c)
    MAPW, MAPH = spec["frame"]["mapW"], spec["frame"]["canvasH"]
    waters = json.load(open(os.path.join(proj_of(spec), spec["waters"]["file"]))) if spec.get("waters") else {}
    GOLD_RGB = col_rgb(spec, "gold")
    for name, B in spec["beats"].items():
        bbox, rot = B["bbox"], B["rot"]
        x0, y0 = ll2c(bbox[0], bbox[3]); x1, y1 = ll2c(bbox[2], bbox[1])
        crop = img.crop((int(x0), int(y0), int(x1), int(y1)))
        cw0 = crop.size[0]   # 旋转前宽(ROTATE_90 映射用, 判例)
        if rot: crop = crop.transpose(Image.ROTATE_90)
        cw, ch = crop.size
        s = max(MAPW/cw, MAPH/ch)
        nw, nh = int(cw*s), int(ch*s)
        base = crop.resize((nw, nh), Image.LANCZOS)
        bx, by = B.get("bias", (0.56, 0.46))
        tp = ll2c(*ll_of(spec, locs, B["cur"][0]))
        tx, ty = tp[0]-x0, tp[1]-y0
        if rot: tx, ty = ty, cw0-1-tx
        ox = int(min(max(0, tx*s - bx*MAPW), max(0, nw-MAPW)))
        oy = int(min(max(0, ty*s - by*MAPH), max(0, nh-MAPH)))
        base = base.crop((ox, oy, ox+MAPW, oy+MAPH))
        def T(p, _x0=x0, _y0=y0, _cw0=cw0, _rot=rot, _s=s, _ox=ox, _oy=oy):
            x, y = p[0]-_x0, p[1]-_y0
            if _rot: x, y = y, _cw0-1-x
            return (x*_s-_ox, y*_s-_oy)
        ov = Image.new("RGBA", (MAPW, MAPH), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        # 0) 水面(恒定 3px 白边)
        for wname, poly in waters.items():
            c = [T(ll2c(*pt)) for pt in poly]
            c_ = tuple(spec["waters"]["colors"].get(wname, spec["waters"]["defaultColor"]))
            d.polygon(c, fill=c_)
            d.line(c+[c[0]], fill=(255, 255, 255, 230), width=3)
        # 1) 计划线（亮背景判例 EP9：雪山/灰岩底上白壳线稿隐身，一律深壳垫底再叠亮壳）
        # EP10 判例：主线必须先画、支线后画——rawGeo 按名字序 main 垫底时宽壳金线会把
        # 同走廊支线（spoke_sanwan 绿）整条盖没（主人判「三湾线和村里线一个色」病根）
        DARK = (30, 26, 20)
        for seg in sorted(ALLSEG, key=lambda k: (k != "main", k)):
            keys = ALLSEG[seg]
            q = [T(p) for p in resolve(keys)]
            core = tuple(RAWGEO[seg]["core"]) if seg in RAWGEO else (94, 78, 58)
            d.line(q, fill=DARK+(150,), width=22, joint="curve")
            d.line(q, fill=(255, 255, 255, 225), width=16, joint="curve")
            d.line(q, fill=core+(255,), width=10, joint="curve")
        for a, b_ in spec["routes"]["walk"].values():
            pts = [T(p) for p in seg_pts([a, b_], locs, ll2c)]
            draw_dash(d, pts, DARK+(170,), 15)
            draw_dash(d, pts, (255, 255, 255, 235), 9)
        # rawGeo 步行虚线（dash:true 的坐标链）
        for seg, rg in RAWGEO.items():
            if rg.get("dash"):
                q = [T(p) for p in resolve(rg["coordinates"])]
                draw_dash(d, q, DARK+(170,), 15)
                draw_dash(d, q, tuple(rg["core"])+(235,), 9)
        # 2) 走过(灰绿压暗；亮背景判例 EP9：灰绿芯在亮灰岩底全图尺度不可辨，芯加深+壳提 alpha)
        for seg, a, b in B["done"]:
            keys = ALLSEG[seg] if seg in ALLSEG else [a, b]
            pts = cut(resolve(keys), ll2c(*ll_of(spec, locs, a)), ll2c(*ll_of(spec, locs, b)))
            q = [T(p) for p in pts]
            d.line(q, fill=DARK+(150,), width=16, joint="curve")
            d.line(q, fill=(85, 90, 80, 235), width=10, joint="curve")
        # 3) 当前段(车=金实线 / 步行=金壳白芯虚线)
        seg, a, b, kind = B["leg"]
        keys = ALLSEG[seg] if seg in ALLSEG else [a, b]
        pts = cut(resolve(keys), ll2c(*ll_of(spec, locs, a)), ll2c(*ll_of(spec, locs, b)))
        q = [T(p) for p in pts]
        if kind == "bus":
            d.line(q, fill=DARK+(170,), width=22, joint="curve")
            d.line(q, fill=(255, 255, 255, 235), width=16, joint="curve")
            d.line(q, fill=GOLD_RGB+(255,), width=10, joint="curve")
        else:
            draw_dash(d, q, DARK+(200,), 17, dash_px=18)
            draw_dash(d, q, GOLD_RGB+(230,), 12, dash_px=18)
            draw_dash(d, q, (255, 255, 255, 245), 6, dash_px=18)
        comp = Image.alpha_composite(base.convert("RGBA"), ov).convert("RGB")
        comp.save(os.path.join(workdir, f"beat_{name}.png"))
        # meta(锚点+变换参数, 动化复用)
        m = {"tag": B["tag"], "tl": B["tl"], "cur": B["cur"],
             "done_stops": B.get("doneStops", []), "todo_stops": B.get("todoStops", []),
             "x0": x0, "y0": y0, "cw0": cw0, "rot": rot, "s": s, "ox": ox, "oy": oy,
             "leg": B["leg"]}
        for k in locs:
            m[k] = T(ll2c(*locs[k]))
        for k, v in (spec.get("specialPoints") or {}).items():
            m[k] = T(ll2c(*v))
        json.dump(m, open(os.path.join(workdir, f"beat_meta_{name}.json"), "w"))
        # ---- 标注 HTML ----
        write_beat_html(spec, workdir, name, m)
        print("beat ok", name, f"scale {s:.2f}")

def write_beat_html(spec, workdir, name, m):
    MAPW = spec["frame"]["mapW"]; CW = spec["frame"]["canvasW"]; CH = spec["frame"]["canvasH"]
    tl = m["tl"]
    def label(x, y, t, nm, desc, dx, dy, anc, fs=62, ds=34):
        tt = f"{t} {nm}" if t else nm
        out = (f'<text x="{x+dx:.0f}" y="{y+dy:.0f}" font-size="{fs}" font-weight="800" text-anchor="{anc}" fill="#fff" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="8" paint-order="stroke">{tt}</text>')
        if desc:
            out += (f'<text x="{x+dx:.0f}" y="{y+dy+ds+12:.0f}" font-size="{ds}" text-anchor="{anc}" fill="#F2C879" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="6" paint-order="stroke">{desc}</text>')
        return out
    def hollow_badge(x, y, n, r=24, fs=24):
        return (f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="rgba(26,28,24,0.55)" stroke="rgba(255,255,255,0.75)" stroke-width="4"/>'
                f'<text x="{x:.0f}" y="{y+10:.0f}" font-size="{fs}" font-weight="800" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-family="RuyiSmiley">{n}</text>')
    s = [f'<svg width="{CW}" height="{CH}" viewBox="0 0 {CW} {CH}" xmlns="http://www.w3.org/2000/svg">']
    tag = m["tag"]
    s.append(f'<g id="zone-tag"><rect x="70" y="64" width="{36*len(tag)+56}" height="64" rx="32" fill="rgba(22,24,20,0.72)"/>'
             f'<text x="98" y="106" font-size="34" font-weight="700" fill="#fff" font-family="RuyiSmiley">{tag}</text></g>')
    for k, nm in m["todo_stops"]:
        x, y = m[k]
        # 边缘点文字 clamp（EP10 判例：白哈巴 x≈60 时 middle 锚文字左半出画）
        est = len(nm) * 15
        tx = min(max(x, est // 2 + 8), MAPW - est // 2 - 8)
        s.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="8" fill="#fff" opacity="0.6" stroke="rgba(30,30,26,0.5)" stroke-width="2"/>'
                 f'<text x="{tx:.0f}" y="{y-22:.0f}" font-size="26" text-anchor="middle" fill="#fff" opacity="0.75" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="5" paint-order="stroke">{nm}</text>')
    for k, n, nm in m["done_stops"]:
        x, y = m[k]
        est = len(nm) * 15
        tx = min(max(x, est // 2 + 8), MAPW - est // 2 - 8)
        s.append(hollow_badge(x, y, n))
        s.append(f'<text x="{tx:.0f}" y="{y+52:.0f}" font-size="26" text-anchor="middle" fill="#fff" opacity="0.8" font-family="RuyiSmiley" stroke="{HALO}" stroke-width="5" paint-order="stroke">{nm}</text>')
    ck, n, t, nm, desc, c, lb = m["cur"]
    x, y = m[ck]
    s.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="46" fill="none" stroke="#F2C879" stroke-width="6" opacity="0.95"/>')
    if n:
        s.append(svg_badge(x, y, n, col(spec, c)))
    s.append(label(x, y, t, nm, desc, *lb))
    s.append('</svg>')
    # 面板(三态复用 overview 结构, 行态由 tl 决定)
    panel, panel_css = panel_html(spec)
    rows = spec["overview"]["panel"]["rows"]
    for rn, *_ in rows:
        try:
            frn = float(rn)
            cls = "done" if frn < float(tl) else ("current" if frn == float(tl) else "todo")
        except (TypeError, ValueError):
            cls = "todo"   # EP10「判」行等非数字 rn（EP7 全数字未暴露）
        panel = panel.replace(f'<div class="row" id="tl-{rn}"', f'<div class="row {cls}" id="tl-{rn}"')
    html = f'''<!DOCTYPE html><html><head><meta charset="utf-8"><style>
{FONT_CSS}
body{{margin:0;width:{CW}px;height:{CH}px;position:relative;background:#22241f}}
img.base{{position:absolute;left:0;top:0}}
svg{{position:absolute;left:0;top:0}}
{panel_css}
</style></head><body>
<img class="base" src="beat_{name}.png"/>
{"".join(s)}
{panel}
</body></html>'''
    open(os.path.join(workdir, f"beat_{name}.html"), "w").write(html)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
