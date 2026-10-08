# -*- coding: utf-8 -*-
"""guide_map 阶段五: 动化渲染 (reveal 金线描路+站点级联 / beat 流动光点 / s6card 面板锁定缓推)
用法: ANIM_S2=1.0 python3 render_anim.py <spec.json> <工作目录> <输出目录> [reveal,beats,s6card]
      ANIM_S2=1.0 -> 2560 画布(states) 720p 粗剪;  ANIM_S2=1.5 -> 3840 画布(states4k) 4K 终版
判例: states4k 内容在左上 3840x2160(zoom 无效化)——load_state 裁内容区; s6card 只推地图区面板锁定"""
import json, math, os, subprocess, shutil, sys
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(__file__))
from common import load_spec, load_locs, ll_of, projector, seg_pts, cut, chaikin, subpath, arc_pos, smooth, draw_dash, col_rgb

def main(spec_path, workdir, outdir, jobs):
    spec = load_spec(spec_path)
    S2 = float(os.environ.get("ANIM_S2", "1.0"))
    FPS = spec["anim"]["fps"]
    CW, CH = int(spec["frame"]["canvasW"]*S2), int(spec["frame"]["canvasH"]*S2)
    MAPW_C = int(spec["frame"]["mapW"]*S2)
    GOLD = col_rgb(spec, "gold")
    os.makedirs(outdir, exist_ok=True)
    state_dir = os.path.join(workdir, "states" if S2 == 1.0 else "states4k")
    tmp = os.path.join(workdir, ".anim")
    out_scale = "scale=1280:720,setsar=1" if S2 == 1.0 else "setsar=1"
    locs = load_locs(spec)
    img_nu = Image.open(os.path.join(workdir, "sat_noroute.png")).convert("RGB")
    ll2c = projector(spec, img_nu.size)
    BUS = spec["routes"]["bus"]
    RAWGEO = spec["routes"].get("rawGeo", {})
    ALLSEG = {**BUS, **RAWGEO}   # EP10 起：坐标折线链与站点链同 namespace
    def resolve(keys):
        if isinstance(keys, dict):
            keys = keys["coordinates"]
        if keys and isinstance(keys[0], (list, tuple)):
            return [ll2c(*c) for c in keys]
        return seg_pts(keys, locs, ll2c)

    def W_(v): return max(1, int(round(v*S2)))

    def load_state(name):
        im = Image.open(os.path.join(state_dir, f"v7_{name}.png")).convert("RGB")
        if S2 > 1:
            im = im.crop((0, 0, CW, CH))   # states4k 为 5760x3240, 内容在左上(zoom 无效化判例)
        return im.resize((CW, CH), Image.LANCZOS)

    def encode(name, frames_dir, nframes):
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-i", f"{frames_dir}/f%04d.png",
            "-c:v", "libx264", "-crf", "18" if S2 > 1 else "20", "-preset", "fast", "-pix_fmt", "yuv420p",
            "-vf", out_scale, os.path.join(outdir, f"{name}.mp4")], check=True)
        shutil.rmtree(frames_dir)
        print("encoded", name, f"{nframes}f @{CW}x{CH}")

    def prep(name):
        d = os.path.join(tmp, f"{name}{'_4k' if S2 > 1 else ''}")
        os.makedirs(d, exist_ok=True)
        return d

    def with_overlay(fr, draw_fn):
        ov = Image.new("RGBA", fr.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        draw_fn(d)
        return Image.alpha_composite(fr.convert("RGBA"), ov).convert("RGB")

    # ---- 总览帧变换(与 build_base 同算法; EP10 rotate90:false 分支——原写死旋转映射金线错位) ----
    meta = json.load(open(os.path.join(workdir, "sat_meta.json")))
    L, T, SC, YOFF, TW = meta["L"], meta["T"], meta["SC"], meta["YOFF"], meta["TW"]
    ROT90 = spec["frame"].get("rotate90", True)
    def f_of_c(p):
        if ROT90:
            return ((p[1]-L)*SC*S2, (TW-1-p[0]-T)*SC*S2+YOFF*S2)
        return ((p[0]-L)*SC*S2, (p[1]-T)*SC*S2+YOFF*S2)
    # 校验：任取一个同时存在于 locs 与 sat_meta 的站点做变换对账（build_base 与 render_anim 同算法互证）
    anchor = next((k for k in locs if k in meta and isinstance(meta[k], list) and meta[k] and isinstance(meta[k][0], (int, float))), None)
    if anchor:
        g0 = f_of_c(ll2c(*locs[anchor]))
        assert abs(g0[0]-meta[anchor][0]*S2) < 3*S2 and abs(g0[1]-meta[anchor][1]*S2) < 3*S2, "transform mismatch"
    # 金线日动线
    DAYSEGS = []
    for seg in spec["dayPath"]:
        keys = ALLSEG[seg["seg"]] if seg["seg"] in ALLSEG else [seg["from"], seg["to"]]
        pts = cut(resolve(keys), ll2c(*ll_of(spec, locs, seg["from"])), ll2c(*ll_of(spec, locs, seg["to"])))
        if seg.get("reverse"): pts = list(reversed(pts))
        DAYSEGS.append(([f_of_c(p) for p in pts], seg["mode"]))
    DAY_LENS = [sum(math.hypot(p[i][0]-p[i-1][0], p[i][1]-p[i-1][1]) for i in range(1, len(p))) for p, _ in DAYSEGS]
    DAY_TOT = sum(DAY_LENS)

    def draw_seg_style(d, pts, mode):
        if mode == "bus":
            d.line(pts, fill=(255, 255, 255, 235), width=W_(18), joint="curve")
            d.line(pts, fill=GOLD+(255,), width=W_(10), joint="curve")
        else:
            draw_dash(d, pts, GOLD+(220,), W_(13), W_(22))
            draw_dash(d, pts, (255, 255, 255, 245), W_(7), W_(22))

    def draw_day(d, frac):
        tgt = frac*DAY_TOT; acc = 0
        for (pts, mode), LEN in zip(DAYSEGS, DAY_LENS):
            if tgt >= acc + LEN:
                if LEN > 1: draw_seg_style(d, pts, mode)
                acc += LEN
            else:
                local = (tgt-acc)/LEN if LEN > 0 else 0
                sub = subpath(pts, local)
                if len(sub) > 1: draw_seg_style(d, sub, mode)
                break

    def render_reveal():
        R = spec["anim"]["reveal"]
        dur = R["dur"]; total = int(dur*FPS)
        d0 = prep("reveal")
        base = load_state("base")
        n_stops = len(spec["overview"]["panel"]["rows"]) - 1
        states = {k: load_state(f"reveal_{k}") for k in range(1, n_stops+1)}
        for i in range(total):
            t = i/FPS
            if t < R["traceEnd"]:
                f = smooth(t/R["traceEnd"])
                fr = with_overlay(base.copy(), lambda d: draw_day(d, f))
            else:
                k = min(n_stops, 1 + int((t-R["traceEnd"])/R["holdPer"]))
                fr = states[k].copy()
                t_in = t - (R["traceEnd"] + (k-1)*R["holdPer"])
                if t_in < R["fade"]:
                    prev = states[k-1] if k > 1 else with_overlay(base.copy(), lambda d: draw_day(d, 1.0))
                    fr = Image.blend(prev, fr, smooth(t_in/R["fade"]))
            fr.save(f"{d0}/f{i:04d}.png")
        encode("reveal", d0, total)

    def render_beat(name, dur):
        total = int(dur*FPS)
        d0 = prep(name)
        base = load_state(name)
        m = json.load(open(os.path.join(workdir, f"beat_meta_{name}.json")))
        def T(p):
            x, y = p[0]-m["x0"], p[1]-m["y0"]
            if m["rot"]: x, y = y, m["cw0"]-1-x
            return (x*m["s"]*S2-m["ox"]*S2, y*m["s"]*S2-m["oy"]*S2)
        seg, a, b, kind = m["leg"]
        keys = ALLSEG[seg] if seg in ALLSEG else [a, b]
        pts = cut(resolve(keys), ll2c(*ll_of(spec, locs, a)), ll2c(*ll_of(spec, locs, b)))
        path = [T(p) for p in pts]
        TRAVEL = 0.45*dur

        # 沿线行进徽章（EP10 主人判词 2026-09-27：光点太不明显→icon 化；
        # EP3 张家界规范：圆徽章图钉=深圆底+金描边+白 glyph+下引线点，bus/ped 由 leg kind 驱动）
        def draw_glyph(d, cx, cy, R, fade):
            a = int(255*fade)
            W = (255, 255, 255, a)
            ink = (26, 28, 24, a)
            if kind == "bus":
                bw, bh = R*1.30, R*0.86
                d.rounded_rectangle([cx-bw/2, cy-bh/2, cx+bw/2, cy+bh/2], radius=max(2, int(R*0.16)), fill=W)
                d.rectangle([cx-bw*0.33, cy-bh*0.26, cx-bw*0.02, cy+bh*0.04], fill=ink)   # 左窗
                d.rectangle([cx+bw*0.07, cy-bh*0.26, cx+bw*0.36, cy+bh*0.04], fill=ink)   # 右窗
                for sx in (-1, 1):   # 轮
                    wx = cx + sx*bw*0.28
                    d.ellipse([wx-R*0.11, cy+bh*0.38-R*0.11, wx+R*0.11, cy+bh*0.38+R*0.11], fill=ink)
            else:   # ped
                lw = max(2, int(R*0.15))
                d.ellipse([cx-R*0.16, cy-R*0.54, cx+R*0.16, cy-R*0.22], fill=W)          # 头
                d.line([(cx, cy-R*0.20), (cx, cy+R*0.18)], fill=W, width=lw)             # 身
                d.line([(cx-R*0.30, cy-R*0.05), (cx+R*0.30, cy-R*0.09)], fill=W, width=lw)  # 臂
                d.line([(cx, cy+R*0.18), (cx-R*0.22, cy+R*0.54)], fill=W, width=lw)      # 左腿
                d.line([(cx, cy+R*0.18), (cx+R*0.22, cy+R*0.54)], fill=W, width=lw)      # 右腿

        for i in range(total):
            t = i/FPS
            fr = base.copy()
            if t < TRAVEL + 0.35:
                prog = smooth(min(1.0, t/TRAVEL))
                x, y = arc_pos(path, prog)
                fade = 1.0 if t < TRAVEL else max(0.0, 1-(t-TRAVEL)/0.35)
                RB = W_(19)
                cy = y - RB - W_(9)   # 徽章圆心抬到路线上方，引线下指路线点
                def dot(d):
                    d.ellipse([x-W_(14), y-W_(14), x+W_(14), y+W_(14)], fill=GOLD+(int(80*fade),))
                    d.line([(x, y-W_(3)), (x, cy+RB)], fill=GOLD+(int(230*fade),), width=W_(3))
                    d.ellipse([x-W_(4), y-W_(4), x+W_(4), y+W_(4)], fill=GOLD+(int(245*fade),))
                    d.ellipse([x-RB, cy-RB, x+RB, cy+RB], fill=(26, 28, 24, int(242*fade)),
                              outline=GOLD+(int(235*fade),), width=W_(3))
                    draw_glyph(d, x, cy, RB*0.72, fade)
                fr = with_overlay(fr, dot)
            fr.save(f"{d0}/f{i:04d}.png")
        encode(name, d0, total)

    def render_s6(key="s6card"):
        S = spec["anim"][key]
        dur = S["dur"]; total = int(dur*FPS)
        d0 = prep(key)
        base = load_state(S.get("state", "s6"))   # fullcard=full 态(无 s6 横幅)供 S1 总览收尾等非收藏语境（EP9 判例：s6card 全程烧录收藏横幅，非 S5 段禁用）
        mapimg = base.crop((0, 0, MAPW_C, CH))
        panel = base.crop((MAPW_C, 0, CW, CH))
        CCX, CCY = int(S["center"][0]*S2), int(S["center"][1]*S2)
        for i in range(total):
            t = i/(total-1)
            z = 1.0 + (S["zoom"]-1.0)*smooth(t)
            nw, nh = int(MAPW_C*z), int(CH*z)
            mz = mapimg.resize((nw, nh), Image.LANCZOS)
            ox = int(CCX*z - CCX); oy = int(CCY*z - CCY)
            fr = base.copy()
            fr.paste(mz.crop((ox, oy, ox+MAPW_C, oy+CH)), (0, 0))
            fr.paste(panel, (MAPW_C, 0))
            fr.save(f"{d0}/f{i:04d}.png")
        encode(key, d0, total)

    if "reveal" in jobs: render_reveal()
    if "beats" in jobs:
        bd = spec["anim"]["beatDur"]
        for nm in spec["beats"]:
            render_beat(nm, bd.get(nm, bd["default"]))
    if "s6card" in jobs: render_s6("s6card")
    if "fullcard" in jobs: render_s6("fullcard")

if __name__ == "__main__":
    jobs = sys.argv[4].split(",") if len(sys.argv) > 4 else ["reveal", "beats", "s6card"]
    main(sys.argv[1], sys.argv[2], sys.argv[3], jobs)
