# -*- coding: utf-8 -*-
"""guide_map 决策动效（fx_decision）：不连通打叉 cross / 劝退灰化 gray / 半亮放行 half
用法: python3 fx_decision.py <spec.json> <工作目录> <输出目录> [cross,gray,half]
原理：states/v7_full.png 全亮帧为底，sat_meta 投影（rotate90 分支）重画目标元素，
      帧序列 blend/stamp 后 ffmpeg 编码——不重渲底图（EP10 起：劝退=地图动作的通用语言）。
判例：坐标链 rawGeo 与站点链同 namespace（同 build_beats/render_anim 判例）。
spec["fx"] = {
  "cross":   {"a": "yueliangwan", "b": "kanas-lake-dock", "dur": 3.5},
  "gray":    {"route": "spoke_baihaba", "stop": "baihaba-village", "dur": 3.2},
  "half":    {"route": "spoke_baihaba", "stop": "baihaba-village", "dur": 2.6}
}"""
import json, math, os, subprocess, shutil, sys
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(__file__))
from common import load_spec, load_locs, chaikin, subpath, smooth, draw_dash

# 打包字体（OFL）：packages/guide_map/ → 仓根 assets/fonts/
FONT_TTF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "assets", "fonts", "SmileySans-Oblique.ttf")


def main(spec_path, workdir, outdir, jobs):
    spec = load_spec(spec_path)
    os.makedirs(outdir, exist_ok=True)
    locs = load_locs(spec)
    img_nu = Image.open(os.path.join(workdir, "sat_noroute.png")).convert("RGB")
    W0, H0 = img_nu.size
    bbox = spec["bbox"]
    def ll2c(lng, lat):
        return ((lng - bbox[0]) / (bbox[2] - bbox[0]) * W0, (bbox[3] - lat) / (bbox[3] - bbox[1]) * H0)
    meta = json.load(open(os.path.join(workdir, "sat_meta.json")))
    L, T, SC, YOFF, TW = meta["L"], meta["T"], meta["SC"], meta["YOFF"], meta["TW"]
    ROT90 = spec["frame"].get("rotate90", True)
    def f_of_ll(lng, lat):
        x, y = ll2c(lng, lat)
        if ROT90:
            return ((y - L) * SC * K, (TW - 1 - x - T) * SC * K + YOFF * K)
        return ((x - L) * SC * K, (y - T) * SC * K + YOFF * K)
    S2 = float(os.environ.get("FX_S2", "1.0"))
    state_dir = os.path.join(workdir, "states" if S2 == 1.0 else "states4k")
    full = Image.open(os.path.join(state_dir, "v7_full.png")).convert("RGB")
    if S2 > 1:
        full = full.crop((0, 0, 3840, 2160))   # states4k 5760 画布内容贴左上（同 render_anim 判例）
    CW, CH = full.size
    K = CW / 2562.0   # 投影/像素常数缩放（states 截图宽 2562 判例）
    def W_(v): return max(1, int(round(v * K)))
    FPS = 30
    fx = spec.get("fx", {})
    routes = spec["routes"].get("rawGeo", {})

    def encode(name, frames):
        d = os.path.join(workdir, ".fx", name)
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d, exist_ok=True)
        for i, fr in enumerate(frames):
            fr.save(f"{d}/f{i:04d}.png")
        out_scale = "scale=1280:720,setsar=1" if S2 == 1.0 else "setsar=1"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-i", f"{d}/f%04d.png",
                        "-c:v", "libx264", "-crf", "18" if S2 > 1 else "20", "-preset", "fast", "-pix_fmt", "yuv420p",
                        "-vf", out_scale, os.path.join(outdir, f"{name}.mp4")], check=True)
        shutil.rmtree(d)
        print("encoded", name, f"{len(frames)}f")

    def route_pts(rid):
        return [f_of_ll(*c) for c in routes[rid]["coordinates"]]

    # 缓慢推近（灰化保持段不死帧；裁切+回缩 LANCZOS，底帧高分辨率无画质损失）
    # 用法：fx.gray.zoom=[z0,z1]，全片程平滑推进；多段切片引用同一长视频时 zoom 连续无跳变
    def apply_zoom(img, z, anchor=None):
        if abs(z - 1.0) < 1e-4:
            return img
        W, H = img.size
        ax, ay = anchor or (W / 2, H / 2)
        bw, bh = W / z, H / z
        x0 = min(max(ax - bw / 2, 0), W - bw)
        y0 = min(max(ay - bh / 2, 0), H - bh)
        return img.crop((int(x0), int(y0), int(x0 + bw), int(y0 + bh))).resize((W, H), Image.LANCZOS)

    # ---- cross：a-b 虚线尝试连接 → 闪 → 红叉 stamp 中点 → 虚线淡出 ----
    if "cross" in jobs and "cross" in fx:
        C = fx["cross"]; dur = C.get("dur", 3.5)
        pa, pb = f_of_ll(*locs[C["a"]]), f_of_ll(*locs[C["b"]])
        mid = ((pa[0]+pb[0])/2, (pa[1]+pb[1])/2)
        arc = chaikin([(pa[0], pa[1]), (mid[0], mid[1]-120*K), (pb[0], pb[1])], n=3)
        total = int(dur*FPS)
        frames = []
        for i in range(total):
            t = i/FPS
            fr = full.copy()
            ov = Image.new("RGBA", fr.size, (0, 0, 0, 0))
            d = ImageDraw.Draw(ov)
            if t < 0.7:   # 虚线生长
                sub = subpath(arc, smooth(t/0.7))
                if len(sub) > 1: draw_dash(d, sub, (255, 255, 255, 235), W_(7), W_(20))
            elif t < 1.5:  # 闪 2 次
                if int((t-0.7)/0.2) % 2 == 0:
                    draw_dash(d, arc, (255, 255, 255, 235), W_(7), W_(20))
            elif t < 2.6:  # 红叉 stamp + 虚线淡出
                fade = max(0.0, 1-(t-1.5)/0.9)
                if fade > 0.03: draw_dash(d, arc, (255, 255, 255, int(235*fade)), W_(7), W_(20))
                pop = min(1.0, (t-1.5)/0.25); pop = 1.15*pop - 0.15*pop*pop
                r = int(46*K*pop)
                if r > 0:
                    x, y = mid
                    d.line([(x-r, y-r), (x+r, y+r)], fill=(232, 74, 62, 255), width=W_(14))
                    d.line([(x-r, y+r), (x+r, y-r)], fill=(232, 74, 62, 255), width=W_(14))
                    d.ellipse([x-r-W_(16), y-r-W_(16), x+r+W_(16), y+r+W_(16)], outline=(232, 74, 62, 220), width=W_(7))
            else:          # 红叉留证
                x, y = mid; r = W_(46)
                d.line([(x-r, y-r), (x+r, y+r)], fill=(232, 74, 62, 255), width=W_(14))
                d.line([(x-r, y+r), (x+r, y-r)], fill=(232, 74, 62, 255), width=W_(14))
                d.ellipse([x-r-W_(16), y-r-W_(16), x+r+W_(16), y+r+W_(16)], outline=(232, 74, 62, 220), width=W_(7))
            frames.append(Image.alpha_composite(fr.convert("RGBA"), ov).convert("RGB"))
        encode("cross", frames)

    # ---- gray/half 共用：白哈巴线+徽标灰化覆盖帧 ----
    def gray_cover(alpha=255):
        ov = Image.new("RGBA", full.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        if "route" in fx.get("gray", {}):
            pts = route_pts(fx["gray"]["route"])
            d.line(pts, fill=(240, 238, 232, alpha), width=W_(26), joint="curve")   # 洗纸色盖原红线
            d.line(pts, fill=(126, 128, 122, alpha), width=W_(14), joint="curve")   # 灰芯
        if "stop" in fx.get("gray", {}):
            x, y = f_of_ll(*locs[fx["gray"]["stop"]])
            d.ellipse([x-W_(34), y-W_(34), x+W_(34), y+W_(34)], fill=(240, 238, 232, alpha))
            d.ellipse([x-W_(30), y-W_(30), x+W_(30), y+W_(30)], fill=(126, 128, 122, alpha))
            d.text((x, y-W_(14)), str(fx["gray"].get("stopN", "•")), fill=(240, 238, 232, alpha))
            # 站名文字灰化重写（底帧 SVG 白字盖不住=灰化破绽；盖块+灰字，spec.mainStops labelAt 同位）
            from PIL import ImageFont
            fnt = ImageFont.truetype(FONT_TTF, W_(58))
            nm = fx["gray"].get("stopName", "")
            if nm:   # 站名文字灰化重写（底帧 SVG 白字盖不住=灰化破绽；盖块+灰字，与 mainStops labelAt 同位）
                lat = fx["gray"].get("labelAt", [30, -40, "start"])
                tx, ty = x + W_(lat[0]), y + W_(lat[1])
                wpx = int(len(nm) * 62 * K) + W_(30)
                d.rectangle([tx - W_(12), ty - W_(66), tx + wpx, ty + W_(8)], fill=(240, 238, 232, alpha))
                d.text((tx, ty - W_(60)), nm, font=fnt, fill=(126, 128, 122, alpha))
        return ov

    if "gray" in jobs and "gray" in fx:
        dur = fx["gray"].get("dur", 3.2); total = int(dur*FPS)
        Z = fx["gray"].get("zoom", None)
        gframe = Image.alpha_composite(full.convert("RGBA"), gray_cover()).convert("RGB")
        frames = []
        for i in range(total):
            t = i/FPS
            base = Image.blend(full, gframe, smooth(t/1.1)) if t < 1.1 else gframe
            if Z:
                base = apply_zoom(base, Z[0] + (Z[1]-Z[0]) * smooth(i/max(total-1, 1)))
            frames.append(base)
        encode("gray", frames)

    if "half" in jobs and "half" in fx:
        dur = fx["half"].get("dur", 2.6); total = int(dur*FPS)
        Z = fx["half"].get("zoom", None)
        gframe = Image.alpha_composite(full.convert("RGBA"), gray_cover()).convert("RGB")
        hframe = Image.blend(full, gframe, 0.55)   # 半亮=45% 灰化
        frames = []
        for i in range(total):
            t = i/FPS
            base = Image.blend(gframe, hframe, smooth(t/0.9)) if t < 0.9 else hframe
            if Z:
                base = apply_zoom(base, Z[0] + (Z[1]-Z[0]) * smooth(i/max(total-1, 1)))
            frames.append(base)
        encode("half", frames)


if __name__ == "__main__":
    jobs = sys.argv[4].split(",") if len(sys.argv) > 4 else ["cross", "gray", "half"]
    main(sys.argv[1], sys.argv[2], sys.argv[3], jobs)
