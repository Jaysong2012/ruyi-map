# -*- coding: utf-8 -*-
"""guide_map 公共层：spec 装载 / 投影 / 平滑 / 洗纸 / 绘图助手
卫星洗纸攻略地图管线（总览+区域推进+时刻表信息层一条命令出图）"""
import json, math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# 打包字体（OFL，仓内 assets/fonts/）：SVG/HTML 一律用 RuyiSmiley，禁系统字体名（跨平台事故源）
FONT_FAMILY = "'RuyiSmiley',sans-serif"
FONT_CSS = ("@font-face{font-family:'RuyiSmiley';"
            "src:url('/fonts/SmileySans-Oblique.ttf') format('truetype')}")

def load_spec(spec_path):
    spec = json.load(open(spec_path))
    spec["_dir"] = os.path.dirname(os.path.abspath(spec_path))
    # rawGeo 坐标链可抽外部文件瘦身：routes.rawGeoFile（相对 spec 目录）→ 合并为 routes.rawGeo
    rg = (spec.get("routes") or {}).get("rawGeoFile")
    if rg and "rawGeo" not in (spec.get("routes") or {}):
        spec["routes"]["rawGeo"] = json.load(open(os.path.join(spec["_dir"], rg)))
    return spec

def proj_of(spec):
    """项目根：spec.proj 显式指定，否则默认 spec 文件所在目录（开源版不再要求绝对路径）。"""
    return spec.get("proj") or spec["_dir"]

def load_locs(spec):
    locs = {l['id']: l['coordinates'] for l in json.load(open(os.path.join(proj_of(spec), spec["locationsFile"])))['locations']}
    for k, v in (spec.get("locOverrides") or {}).items():
        locs[k] = list(v)
    return locs

def ll_of(spec, locs, k):
    sp = (spec.get("specialPoints") or {})
    return tuple(sp[k]) if k in sp else locs[k]

def projector(spec, img_size):
    TB = spec["bbox"]; TW, TH = img_size
    def ll2c(lng, lat):
        return ((lng-TB[0])/(TB[2]-TB[0])*TW, (TB[3]-lat)/(TB[3]-TB[1])*TH)
    return ll2c

def chaikin(pts, n=3):
    for _ in range(n):
        out = [pts[0]]
        for i in range(len(pts)-1):
            p, q = pts[i], pts[i+1]
            out += [(0.75*p[0]+0.25*q[0], 0.75*p[1]+0.25*q[1]), (0.25*p[0]+0.75*q[0], 0.25*p[1]+0.75*q[1])]
        out.append(pts[-1]); pts = out
    return pts

def seg_pts(keys, locs, ll2c):
    p = [ll2c(*locs[k]) for k in keys]
    return chaikin(p) if len(p) > 2 else p

def cut(pts, pa, pb):
    """截 pa→pb 子折线(pa/pb 为 northup 像素坐标)"""
    ia = min(range(len(pts)), key=lambda i: (pts[i][0]-pa[0])**2+(pts[i][1]-pa[1])**2)
    ib = min(range(len(pts)), key=lambda i: (pts[i][0]-pb[0])**2+(pts[i][1]-pb[1])**2)
    if ia > ib: ia, ib = ib, ia
    return pts[ia:ib+1]

def wash(base_rgb, w):
    """洗纸底: 模糊+降饱和+提亮+局部对比压缩+微暖 (EP7 v7 配方)"""
    bw = base_rgb.filter(ImageFilter.GaussianBlur(w["blur"]))
    ba = np.asarray(bw).astype(np.float32)
    m_ = ba.mean(-1, keepdims=True)
    ba = m_ + (ba-m_)*w["desat"]
    ba = np.clip(ba*w["brightenMul"] + w["brightenAdd"], 0, 255)
    local = ba.mean(-1, keepdims=True)
    ba = np.clip(local + (ba-local)*w["localContrast"], 0, 255)
    ba[..., 0] = np.clip(ba[..., 0]*w["warmR"], 0, 255)
    ba[..., 2] = np.clip(ba[..., 2]*w["warmB"], 0, 255)
    return Image.fromarray(ba.astype(np.uint8))

def draw_dash(d, q, color, w, dash_px=22):
    for i in range(len(q)-1):
        (ax, ay), (bx, by) = q[i], q[i+1]
        L = math.hypot(bx-ax, by-ay); steps = max(1, int(L//dash_px))
        for j in range(0, steps, 2):
            t0, t1 = j/steps, min(1, (j+1)/steps)
            d.line([(ax+(bx-ax)*t0, ay+(by-ay)*t0), (ax+(bx-ax)*t1, ay+(by-ay)*t1)], fill=color, width=w)

def subpath(pts, frac):
    Lq = [0]
    for i in range(1, len(pts)):
        Lq.append(Lq[-1] + math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]))
    tot = Lq[-1]; tgt = frac*tot
    sub = [pts[0]]
    for i in range(1, len(pts)):
        if Lq[i] <= tgt: sub.append(pts[i])
        else:
            t = 0 if Lq[i] == Lq[i-1] else (tgt-Lq[i-1])/(Lq[i]-Lq[i-1])
            sub.append((pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t, pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t))
            break
    return sub

def arc_pos(pts, frac):
    L = [0]
    for i in range(1, len(pts)):
        L.append(L[-1] + math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]))
    tot = L[-1]; tgt = frac*tot
    for i in range(1, len(pts)):
        if L[i] >= tgt:
            t = 0 if L[i] == L[i-1] else (tgt-L[i-1])/(L[i]-L[i-1])
            return (pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t, pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t)
    return pts[-1]

def smooth(t): return t*t*(3-2*t)

def col(spec, name):
    return spec["colors"][name]

def col_rgb(spec, name):
    h = spec["colors"][name].lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
