# -*- coding: utf-8 -*-
"""guide_map 阶段四: 状态截图 (总览状态机 + beats, 双规格 states/states4k)
用法: python3 render_states.py <spec.json> <工作目录> [--4k]
依赖: node + playwright-core（仓根 npm install）+ 本地 http 服务(脚本自动起 8377, 哨兵防串台)
判例: states4k 用 CSS zoom 无效化(内容 2560 贴左上 5760 画布)——下游 render_anim 裁左上内容区, 勿直接当满幅用"""
import json, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from common import load_spec

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

def ensure_fonts(workdir):
    """HTML/SVG 的 RuyiSmiley 经 /fonts/ 相对 URL 加载——打包字体拷进 workdir（幂等）。"""
    dst = os.path.join(workdir, "fonts")
    os.makedirs(dst, exist_ok=True)
    src = os.path.join(REPO_ROOT, "assets", "fonts", "SmileySans-Oblique.ttf")
    tgt = os.path.join(dst, "SmileySans-Oblique.ttf")
    if not os.path.exists(tgt):
        shutil.copy(src, tgt)

PORT = 8377
import hashlib
# EP9/EP10 串台判例（2026-09-27）：8377 固定端口+「能通就复用」→ 并发的另一项目 http.server 被当成自己的，
# 截图截回别家 final_sat.html 污染 states4k（EP9 收藏卡渲成喀纳斯）。根治：哨兵文件校验 serve 目录，
# 不符就换端口；playwright session 按 workdir 哈希隔离（共享 session 并发互抢页面同源）。
def _session_for(workdir):
    return "guidemap-" + hashlib.md5(os.path.abspath(workdir).encode()).hexdigest()[:8]

def ensure_server(workdir):
    import urllib.request
    sentinel = os.path.join(workdir, ".gm_sentinel")
    with open(sentinel, "w") as f:
        f.write(os.path.abspath(workdir))
    def serves_me(port):
        try:
            body = urllib.request.urlopen(f"http://localhost:{port}/.gm_sentinel", timeout=1).read().decode()
            return body == os.path.abspath(workdir)
        except Exception:
            return False
    if serves_me(PORT):
        return None, PORT
    port = PORT
    for cand in range(PORT, PORT + 20):
        try:
            urllib.request.urlopen(f"http://localhost:{cand}/", timeout=0.5)
            continue   # 端口被占且不是我的 → 下一个
        except Exception:
            port = cand
            break
    p = subprocess.Popen(["python3", "-m", "http.server", str(port)], cwd=workdir,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2)
    return p, port

def run_shots(base_url, items):
    """整批截图走一个 node 浏览器会话（state_shot.mjs）。"""
    job = os.path.join(os.path.dirname(items[0]["out"]), ".shot_job.json")
    with open(job, "w") as f:
        json.dump({"baseUrl": base_url, "items": items}, f, ensure_ascii=False)
    r = subprocess.run(["node", os.path.join(HERE, "state_shot.mjs"), job])
    if r.returncode != 0:
        sys.exit(r.returncode)
    os.remove(job)

def state_spec(spec, name):
    """总览状态机: base/reveal_1..N/beat_*/s6/full -> (元素 opacity 表, 面板行态表)"""
    ov = spec["overview"]
    rows = [r[0] for r in ov["panel"]["rows"]]
    mains = [st["n"] for st in ov["mainStops"]]
    insets = [st["n"] for st in ov.get("insetStops", [])]
    dots = [d["n"] for d in ov.get("dots", [])]
    allg = [f"stop-{n}" for n in mains] + [f"istop-{n}" for n in insets] + [f"mdot-{n}" for n in dots] + ["coverbox"]
    op = {g: 0 for g in allg}
    op["__inset__"] = 0; op["inset-chrome"] = 0; op["s6-banner"] = 0; op["ring"] = 0
    tl = {r: "todo" for r in rows}
    main_set = set(mains); inset_set = set(insets)
    if name == "base":
        pass
    elif name.startswith("reveal_"):
        k = int(name.split("_")[1])
        lit = [str(i) for i in range(1, k+1)]
        for n in lit:
            # 主站与 inset 站同 n 时两侧都点（EP10 判例：原 elif 短路——EP7 两集无重叠未暴露，
            # EP10 mainStops n=1-6 全覆盖必然重叠，inset 内三湾同号标注永灭）
            if n in main_set: op[f"stop-{n}"] = 1
            if n in inset_set: op[f"istop-{n}"] = 1
        if any(n in inset_set for n in lit):
            op["__inset__"] = 1; op["inset-chrome"] = 1; op["coverbox"] = 1   # 覆盖框随 inset 联动(判例)
        for i, n in enumerate(lit):
            tl[n] = "done" if i < len(lit)-1 else "current"
    elif name == "s6":
        for g in allg: op[g] = 1
        op["__inset__"] = 1; op["inset-chrome"] = 1; op["s6-banner"] = 1
        tl = {r: "done" for r in rows}
    elif name == "full":
        for g in allg: op[g] = 1
        op["__inset__"] = 1; op["inset-chrome"] = 1
        tl = {r: "" for r in rows}
    return op, tl

def js(op, tl, meta):
    parts = []
    for gid, v in op.items():
        if gid == "__inset__":
            parts.append(f"document.querySelector('img.inset').style.display={'\"block\"' if v else '\"none\"'};")
        elif gid == "__ring__":
            continue
        else:
            # 属性选择器命中全部同 id 元素（EP10 判例：同 n 多站——三湾同号 n=3——getElementById 只控第一个，其余失控常亮）
            parts.append(f"document.querySelectorAll('[id=\\'{gid}\\']').forEach(e=>e.style.opacity={v});")
    for n, cls in tl.items():
        parts.append(f"var r=document.getElementById('tl-{n}');if(r)r.className='row {cls}';")
    return "".join(parts)

def main(spec_path, workdir, hi4k):
    spec = load_spec(spec_path)
    ensure_fonts(workdir)
    _, port = ensure_server(workdir)
    meta = json.load(open(os.path.join(workdir, "sat_meta.json")))
    n_stops = len(spec["overview"]["panel"]["rows"]) - 1   # 末班车行不进 reveal 级联
    outdir = os.path.join(workdir, "states4k" if hi4k else "states")
    os.makedirs(outdir, exist_ok=True)
    zoom_js = "document.body.style.zoom=1.5; document.body.style.width='3840px'; document.body.style.height='2160px';"
    items = []
    names = ["base"] + [f"reveal_{i}" for i in range(1, n_stops+1)] + ["s6", "full"]
    for nm in names:
        op, tl = state_spec(spec, nm)
        it = {"page": "final_sat.html", "out": os.path.join(outdir, f"v7_{nm}.png"),
              "js": js(op, tl, meta)}
        if hi4k: it["zoomJs"] = zoom_js
        items.append(it)
    for b in spec["beats"]:
        it = {"page": f"beat_{b}.html", "out": os.path.join(outdir, f"v7_{b}.png")}
        if hi4k: it["zoomJs"] = zoom_js
        items.append(it)
    run_shots(f"http://localhost:{port}", items)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], "--4k" in sys.argv)
