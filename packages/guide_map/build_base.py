# -*- coding: utf-8 -*-
"""guide_map 阶段一: 底图构建
瓦片拼接(读缓存) -> 洗纸 -> 水面平涂 -> 路线 -> sat_clean/sat_noroute/sat_frame/sat_inset/sat_meta
用法: python3 build_base.py <spec.json> <工作目录(产物落点, 如 .work/redesign)>
判例: 马赛克宽度必须够 ROTATE_90 后的取景高(EP7 加宽 103.74-104.04 教训); TB 与马赛克 bbox 必须一致"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(__file__))
from common import load_spec, proj_of, load_locs, projector, chaikin, wash, draw_dash

def deg2tile(lng, lat, z):
    n = 2**z
    x = (lng+180)/360*n
    lat_r = math.radians(lat)
    y = (1-math.log(math.tan(lat_r)+1/math.cos(lat_r))/math.pi)/2*n
    return x, y

def mosaic(spec, z, out):
    bbox = spec["bbox"]
    proj = proj_of(spec)
    x0f, ynf = deg2tile(bbox[0], bbox[3], z)
    x1f, ysf = deg2tile(bbox[2], bbox[1], z)
    x0, x1 = int(math.floor(x0f)), int(math.ceil(x1f))
    y0, y1 = int(math.floor(ynf)), int(math.ceil(ysf))
    img = Image.new("RGB", ((x1-x0)*256, (y1-y0)*256))
    missing = 0
    for tx in range(x0, x1):
        for ty in range(y0, y1):
            p = f"{proj}/map/data/sat/{z}/{tx}/{ty}.jpg"
            if os.path.exists(p):
                img.paste(Image.open(p).convert("RGB"), ((tx-x0)*256, (ty-y0)*256))
            else:
                missing += 1
    px0, py0 = (x0f-x0)*256, (ynf-y0)*256
    px1, py1 = (x1f-x0)*256, (ysf-y0)*256
    img = img.crop((int(px0), int(py0), int(px1), int(py1)))
    img.save(out)
    print(f"mosaic z{z}: {x1-x0}x{y1-y0} tiles, missing {missing}, out {img.size}")
    return img

def main(spec_path, workdir):
    spec = load_spec(spec_path)
    os.makedirs(workdir, exist_ok=True)
    Z = 14
    sat_path = os.path.join(workdir, "sat14_full.png")
    if not os.path.exists(sat_path):
        base = mosaic(spec, Z, sat_path)
    else:
        base = Image.open(sat_path).convert("RGB")
    # ---- 阴影提升+提饱和(EP7 配方) ----
    sat = np.array(base).astype(np.float32)/255
    r, g, b = sat[..., 0], sat[..., 1], sat[..., 2]
    mx = sat.max(-1); mn = sat.min(-1); df = mx-mn
    v = np.clip(mx, 0, 1) ** 0.72
    s = np.where(mx > 1e-6, df/np.maximum(mx, 1e-6), 0)
    s2 = np.clip(s*1.30, 0, 1)
    h = np.zeros_like(mx)
    m = df > 1e-6
    idx = m & (mx == r); h[idx] = ((g-b)[idx]/df[idx]) % 6
    idx = m & (mx == g); h[idx] = (b-r)[idx]/df[idx]+2
    idx = m & (mx == b); h[idx] = (r-g)[idx]/df[idx]+4
    h = h*60
    cyan = (h > 80) & (h < 200) & (s > 0.25)
    s2 = np.where(cyan, np.clip(s*1.45, 0, 1), s2)
    v2 = np.where(cyan, np.clip(np.clip(mx,0,1)**0.65*1.08, 0, 1), v)
    i = np.floor(h/60) % 6; f = h/60-np.floor(h/60)
    p = v2*(1-s2); q = v2*(1-f*s2); t = v2*(1-(1-f)*s2)
    rgb = np.zeros_like(sat)
    for k, (rr, gg, bb) in enumerate([(v2,t,p),(q,v2,p),(p,v2,t),(p,q,v2),(t,p,v2),(v2,p,q)]):
        mk = (i == k)
        rgb[..., 0] = np.where(mk, rr, rgb[..., 0]); rgb[..., 1] = np.where(mk, gg, rgb[..., 1]); rgb[..., 2] = np.where(mk, bb, rgb[..., 2])
    base = Image.fromarray((np.clip(rgb, 0, 1)*255).astype(np.uint8))
    # ---- 洗纸 ----
    base = wash(base, spec["wash"])
    base.save(os.path.join(workdir, "sat_clean.png"))   # 无水无路净底(beat 矢量重画水面/路线用)
    TW, TH = base.size
    ll2c = projector(spec, base.size)
    locs = load_locs(spec)
    routes = spec["routes"]
    # ---- 路线层 ----
    ov = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    def route(keys, core=(94, 78, 58, 255), w=10, alpha=255):
        pts = chaikin([ll2c(*locs[k]) for k in keys])
        d.line(pts, fill=(255, 255, 255, 235), width=w+8, joint="curve")
        d.line(pts, fill=core[:3]+(alpha,), width=w, joint="curve")
    muted = routes.get("tailMuted")
    for name, keys in routes.get("bus", {}).items():
        if name == muted:
            route(keys, core=(150, 140, 118), w=7, alpha=170)
        else:
            route(keys)
    for a, b_ in routes.get("walk", {}).values():
        pa, pb = ll2c(*locs[a]), ll2c(*locs[b_])
        steps = max(2, int(math.hypot(pb[0]-pa[0], pb[1]-pa[1])//16))
        for j in range(0, steps, 2):
            t0, t1 = j/steps, min(1, (j+1)/steps)
            d.line([(pa[0]+(pb[0]-pa[0])*t0, pa[1]+(pb[1]-pa[1])*t0),
                    (pa[0]+(pb[0]-pa[0])*t1, pa[1]+(pb[1]-pa[1])*t1)], fill=(255, 255, 255, 245), width=7)
    # ---- rawGeo 真实路网折线（EP10 起：坐标直接给，不走站点链 chaikin——描路沿真实路网判例） ----
    for name, rg in routes.get("rawGeo", {}).items():
        pts = [ll2c(*c) for c in rg["coordinates"]]
        core = tuple(rg.get("core", (94, 78, 58)))
        w = rg.get("w", 10); alpha = rg.get("alpha", 255)
        if rg.get("dash"):  # 步行虚线（金壳白芯）
            draw_dash(d, pts, (255, 255, 255, 245), w + 4)
            draw_dash(d, pts, core + (alpha,), w)
        else:
            d.line(pts, fill=(255, 255, 255, 235), width=w + 8, joint="curve")
            d.line(pts, fill=core + (alpha,), width=w, joint="curve")
    # ---- 水面层（可选：spec.waters 存在才叠；无水面项目直接跳过）----
    waters = json.load(open(os.path.join(proj_of(spec), spec["waters"]["file"]))) if spec.get("waters") else {}
    wv = Image.new("RGBA", base.size, (0, 0, 0, 0))
    dw = ImageDraw.Draw(wv)
    for name, poly in waters.items():  # noqa: waters={} 时水面层为空
        c = [ll2c(*pt) for pt in poly]
        col = tuple(spec["waters"]["colors"].get(name, spec["waters"]["defaultColor"]))
        dw.polygon(c, fill=col)
        dw.line(c+[c[0]], fill=(255, 255, 255, 230), width=spec["waters"]["outline"])
    comp = Image.alpha_composite(base.convert("RGBA"), wv)
    comp.convert("RGB").save(os.path.join(workdir, "sat_noroute.png"))  # 有水面无路线
    comp2 = Image.alpha_composite(comp, ov)
    comp2.convert("RGB").save(os.path.join(workdir, "sat_northup.png"))
    # ---- 旋转+取景(地图区 mapW, 右侧让位面板) ----
    MAPW = spec["frame"]["mapW"]; CW, CH = spec["frame"]["canvasW"], spec["frame"]["canvasH"]
    MARGIN = spec["frame"]["margin"]
    ROT90 = spec["frame"].get("rotate90", True)  # EP7 南北向沟域转 90° 横放；东西向分布项目（EP10）关
    rot = comp2.transpose(Image.ROTATE_90) if ROT90 else comp2
    RW, RH = rot.size
    if ROT90:
        def ll2r(lng, lat):
            x, y = ll2c(lng, lat); return (y, TW-1-x)
    else:
        ll2r = ll2c
    xs, ys = [], []
    for vv in locs.values():
        p = ll2r(*vv); xs.append(p[0]); ys.append(p[1])
    cx, cy = (min(xs)+max(xs))/2, (min(ys)+max(ys))/2
    span = max(max(xs)-min(xs)+MARGIN, (max(ys)-min(ys)+MARGIN)*MAPW/CH)
    win_w = min(span, RW); win_h = win_w*CH/MAPW
    if win_h > RH: win_h = RH; win_w = win_h*MAPW/CH
    L = max(0, min(RW-win_w, cx-win_w/2)); T = max(0, min(RH-win_h, cy-win_h/2))
    frame = rot.crop((int(L), int(T), int(L+win_w), int(T+win_h)))
    SC = MAPW/frame.size[0]
    frame = frame.resize((MAPW, int(frame.size[1]*SC)), Image.LANCZOS)
    canvas = Image.new("RGB", (CW, CH), (34, 36, 32))
    YOFF = (CH-frame.size[1])//2
    canvas.paste(frame, (0, YOFF))
    canvas.save(os.path.join(workdir, "sat_frame.png"))
    def ll2f(lng, lat):
        p = ll2r(lng, lat)
        return ((p[0]-L)*SC, (p[1]-T)*SC+YOFF)
    # ---- 放大窗 ----
    ins = spec["inset"]
    FB = ins["bbox"]
    c0, c1 = ll2c(FB[0], FB[3]), ll2c(FB[2], FB[1])
    ic = comp2.crop((int(c0[0]), int(c0[1]), int(c1[0]), int(c1[1])))
    if ins.get("extraBrighten"):
        a = np.asarray(ic).astype(np.float32)/255
        lum = a.mean(-1, keepdims=True)
        lifted = np.clip(a * (1 + 0.85*(1-lum)**1.6), 0, 1)
        mean = lifted.mean(-1, keepdims=True)
        lifted = np.clip((lifted-mean)*1.12+mean*1.04, 0, 1)
        ic = Image.fromarray((lifted*255).astype(np.uint8))
    ISC = ins["scale"]
    ic = ic.resize((int(ic.size[0]*ISC), int(ic.size[1]*ISC)), Image.LANCZOS)
    ic.save(os.path.join(workdir, "sat_inset.png"))
    IW, IH = ic.size
    IX, IY = ins["at"]
    def ll2i(lng, lat):
        p = ll2c(lng, lat)
        return (IX+(p[0]-c0[0])*ISC, IY+(p[1]-c0[1])*ISC)
    meta = {"IX": IX, "IY": IY, "IW": IW, "IH": IH,
            "L": L, "T": T, "SC": SC, "YOFF": YOFF, "TW": TW}
    all_keys = list(locs.keys())
    for k in all_keys:
        meta[k] = ll2f(*locs[k])
        meta["in_"+k] = ll2i(*locs[k])
    for k, v in (spec.get("specialPoints") or {}).items():
        meta[k] = ll2f(*v)
        meta["in_"+k] = ll2i(*v)
    meta["fb_main"] = [ll2f(FB[0], FB[3]), ll2f(FB[2], FB[3]), ll2f(FB[2], FB[1]), ll2f(FB[0], FB[1])]
    json.dump(meta, open(os.path.join(workdir, "sat_meta.json"), "w"))
    print("build_base ok:", workdir)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
