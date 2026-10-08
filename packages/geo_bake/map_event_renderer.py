#!/usr/bin/env python3
"""Deterministic renderer for time-aligned map-event broadcasts."""
from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageStat

REPO = Path(__file__).resolve().parents[2]   # ruyi-map 仓根（packages/geo_bake/ 上两级）
FONT_DIR = REPO / "assets/fonts"
FONT_HERO = FONT_DIR / "ZCOOLQingKeHuangYou-Regular.ttf"
FONT_BODY = FONT_DIR / "LXGWWenKai-Medium.ttf"
FONT_DATA = FONT_DIR / "SpaceGrotesk.ttf"


def lerp(a, b, u): return a + (b - a) * u
def clamp(v): return max(0.0, min(1.0, v))
def merc_y(lat):
    lat = max(-85.05112878, min(85.05112878, lat))
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def color(value, default=(255, 211, 112)):
    if not value: return default
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def dashed(draw, points, fill, width, dash, gap):
    for a, b in zip(points, points[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length == 0: continue
        pos = 0.0
        while pos < length:
            end = min(length, pos + dash)
            draw.line((a[0] + dx*pos/length, a[1] + dy*pos/length,
                       a[0] + dx*end/length, a[1] + dy*end/length), fill=fill, width=width)
            pos += dash + gap


class Renderer:
    def __init__(self, spec_path: Path, mode: str):
        self.project = spec_path.parent
        self.spec = json.loads(spec_path.read_text(encoding="utf-8"))
        self.mode = mode
        self.w, self.h = self.spec["canvas"][mode]
        self.scale = self.h / 720
        self.fps = self.spec.get("fps", 30)
        self.duration = self.spec["durationSeconds"]
        self.map = Image.open(self.project / self.spec["map"]["image"]).convert("RGB")
        geo = json.loads((self.project / self.spec["map"]["geoSidecar"]).read_text(encoding="utf-8"))
        self.bounds = geo.get("bounds") or geo["window_real"]
        self.projection = geo.get("projection") or geo.get("crs", "web_mercator")
        self.track = sorted(self.spec["track"], key=lambda p: p["at"])
        self.events = self.spec.get("events", [])
        self.camera = sorted(self.spec["camera"], key=lambda p: p["at"])
        self.layers = self.spec.get("layers", [])
        self.layer_cache = {}

    def font(self, path, size):
        return ImageFont.truetype(str(path), round(size * self.scale))

    def world_xy(self, lon, lat):
        west, south, east, north = self.bounds
        x = (lon - west) / (east - west) * self.map.width
        if self.projection == "web_mercator":
            y = (merc_y(north) - merc_y(lat)) / (merc_y(north) - merc_y(south)) * self.map.height
        else:
            y = (north - lat) / (north - south) * self.map.height
        return x, y

    def viewport(self, t):
        before, after = self.camera[0], self.camera[-1]
        for a, b in zip(self.camera, self.camera[1:]):
            if a["at"] <= t <= b["at"]:
                before, after = a, b
                break
        u = clamp((t - before["at"]) / max(.001, after["at"] - before["at"]))
        return [lerp(before[k], after[k], u) for k in ("west", "south", "east", "north")]

    def map_xy(self, lon, lat, vp):
        x0, y1 = self.world_xy(vp[0], vp[1])
        x1, y0 = self.world_xy(vp[2], vp[3])
        x, y = self.world_xy(lon, lat)
        return ((x - x0) / (x1 - x0) * self.w, (y - y0) / (y1 - y0) * self.h)

    def background(self, vp, t):
        x0, y1 = self.world_xy(vp[0], vp[1])
        x1, y0 = self.world_xy(vp[2], vp[3])
        crop = self.map.crop((round(x0), round(y0), round(x1), round(y1)))
        base = crop.resize((self.w, self.h), Image.Resampling.LANCZOS).convert("RGBA")
        for layer in self.layers:
            frames = sorted(layer.get("frames", []), key=lambda p: p["at"])
            if not frames: continue
            before, after = frames[0], frames[-1]
            for a, b in zip(frames, frames[1:]):
                if a["at"] <= t <= b["at"]: before, after = a, b; break
            u = clamp((t - before["at"]) / max(.001, after["at"] - before["at"]))
            def load(item):
                path = self.project / item["image"]
                if path not in self.layer_cache:
                    self.layer_cache[path] = Image.open(path).convert("RGBA").resize(self.map.size, Image.Resampling.LANCZOS)
                im = self.layer_cache[path].crop((round(x0), round(y0), round(x1), round(y1)))
                return im.resize((self.w, self.h), Image.Resampling.LANCZOS)
            lay = Image.blend(load(before), load(after), u) if before != after else load(before)
            if layer.get("opacity", 1) != 1:
                lay.putalpha(lay.getchannel("A").point(lambda a: round(a * layer["opacity"])))
            base = Image.alpha_composite(base, lay)
        return base.convert("RGB")

    def track_until(self, t):
        if t <= self.track[0]["at"]: return []
        out = [dict(p) for p in self.track if p["at"] <= t]
        nxt = next((p for p in self.track if p["at"] > t), None)
        if nxt and out:
            prev = max((p for p in self.track if p["at"] <= t), key=lambda p: p["at"])
            u = clamp((t - prev["at"]) / (nxt["at"] - prev["at"]))
            out.append({"at": t, "lon": lerp(prev["lon"], nxt["lon"], u),
                        "lat": lerp(prev["lat"], nxt["lat"], u),
                        "kind": nxt.get("kind", "observed")})
        return out

    def frame(self, t):
        vp = self.viewport(t)
        base = self.background(vp, t)
        # 地图是证据层，不做全画幅暗化。文字对比应由局部描边/底板解决，不能牺牲海岸线与地名。
        image = base.convert("RGBA")
        ov = Image.new("RGBA", image.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
        route_geo = self.track_until(t)
        route = [self.map_xy(p["lon"], p["lat"], vp) for p in route_geo]
        gold = color(self.spec.get("theme", {}).get("route")); cyan = color(self.spec.get("theme", {}).get("live"), (76, 231, 202))
        if len(route) > 1:
            d.line(route, fill=(5, 10, 18, 220), width=round(15 * self.scale), joint="curve")
            forecast = color(self.spec.get("theme", {}).get("forecast"), (160, 174, 190))
            for i, (a, b) in enumerate(zip(route, route[1:]), 1):
                kind = route_geo[i].get("kind", "observed")
                if kind == "forecast":
                    dashed(d, [a, b], forecast + (220,), round(5*self.scale), round(16*self.scale), round(11*self.scale))
                elif kind == "uncertain":
                    dashed(d, [a, b], forecast + (165,), round(4*self.scale), round(5*self.scale), round(11*self.scale))
                else:
                    d.line((a, b), fill=(cyan if kind == "current" else gold) + (255,), width=round(6*self.scale))
        if route:
            x, y = route[-1]
            r = round(18 * self.scale)
            d.ellipse((x-r*2, y-r*2, x+r*2, y+r*2), fill=cyan + (50,))
            d.ellipse((x-r, y-r, x+r, y+r), outline=cyan + (255,), width=round(4*self.scale))
            d.ellipse((x-4*self.scale, y-4*self.scale, x+4*self.scale, y+4*self.scale), fill=(245,248,250,255))
        # 尚未发生的预测/不确定路径只以虚线预告，不与已发生实线混淆。
        future = [p for p in self.track if p["at"] > t and p.get("kind") in ("forecast", "uncertain")]
        if route and future:
            pts = [route[-1]] + [self.map_xy(p["lon"], p["lat"], vp) for p in future]
            fc = color(self.spec.get("theme", {}).get("forecast"), (160, 174, 190))
            dashed(d, pts, fc + (190,), round(4*self.scale), round(16*self.scale), round(11*self.scale))
        for label in self.spec.get("labels", []):
            x, y = self.map_xy(label["lon"], label["lat"], vp)
            if 0 < x < self.w and 0 < y < self.h:
                d.text((x, y), label["text"], font=self.font(FONT_BODY, label.get("size", 22)), anchor="mm",
                       fill=color(label.get("color"), (232, 237, 242)) + (190,),
                       stroke_width=round(2*self.scale), stroke_fill=(4, 8, 14, 190))
        for ev in self.events:
            if ev["at"] <= t < ev.get("end", ev["at"] + 4.5):
                u = clamp((t - ev["at"]) / .35); a = round(255*u)
                c = color(ev.get("color"), gold)
                x, y = round(58*self.scale), round(405*self.scale)
                d.line((x, y, x+72*self.scale, y), fill=c+(a,), width=round(5*self.scale))
                d.text((x, y+18*self.scale), ev.get("time", "KEY EVENT"), font=self.font(FONT_DATA, 25), fill=c+(a,))
                d.text((x, y+58*self.scale), ev["place"], font=self.font(FONT_HERO, 64), fill=(248,249,247,a), stroke_width=round(3*self.scale), stroke_fill=(4,8,14,a))
                d.text((x, y+132*self.scale), ev["label"], font=self.font(FONT_BODY, 38), fill=c+(a,), stroke_width=round(2*self.scale), stroke_fill=(4,8,14,a))
                break
        image = Image.alpha_composite(image, ov)
        return image.convert("RGB")

    def validate(self):
        assert self.camera and self.camera[0]["at"] == 0
        assert self.camera[-1]["at"] >= self.duration, "camera 必须覆盖全片时长"
        assert all(a["at"] < b["at"] for a, b in zip(self.track, self.track[1:])), "track.at 必须严格递增"
        for ev in self.events:
            assert any(abs(p["at"] - ev["at"]) <= ev.get("trackTolerance", 2.0) for p in self.track), f"事件未对齐轨迹: {ev['label']}"
        appearance = self.spec.get("map", {}).get("appearance", {})
        min_mean = float(appearance.get("minMeanLuma", 48))
        min_lit_ratio = float(appearance.get("minLitPixelRatio", .35))
        samples = sorted({0.0, self.duration, *(float(p["at"]) for p in self.camera)})
        for t in samples:
            bg = self.background(self.viewport(t), t).convert("L").resize((160, 90))
            mean = ImageStat.Stat(bg).mean[0]
            lit_ratio = sum(px >= 40 for px in bg.getdata()) / (160 * 90)
            assert mean >= min_mean and lit_ratio >= min_lit_ratio, (
                f"地图过暗不可播报: t={t:g}s meanLuma={mean:.1f} litPixelRatio={lit_ratio:.1%}; "
                f"最低要求 {min_mean:g}/{min_lit_ratio:.0%}。更换明亮底图或提升底图本身亮度，禁止用黑底遮罩。"
            )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", type=Path)
    ap.add_argument("--mode", choices=("rough", "final"), default="rough")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--frames")
    args = ap.parse_args(); r = Renderer(args.spec.resolve(), args.mode); r.validate()
    if args.frames:
        out = args.out or args.spec.parent / ".work/samples"
        out.mkdir(parents=True, exist_ok=True)
        for raw in args.frames.split(","):
            t = float(raw); r.frame(t).save(out / f"{t:06.2f}.jpg", quality=92)
        return
    out = args.out or args.spec.parent / f".work/map_event_{args.mode}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-vcodec", "png", "-r", str(r.fps), "-i", "-", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(out)], stdin=subprocess.PIPE)
    for i in range(round(r.duration * r.fps)):
        r.frame(i / r.fps).save(proc.stdin, "PNG")
    proc.stdin.close(); raise SystemExit(proc.wait())


if __name__ == "__main__": main()
