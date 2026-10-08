# -*- coding: utf-8 -*-
"""run_pipeline.py — guide_map 时刻表路线地图一条命令出图（2026-09-28 EP9 沉淀，主人判词「希望能够脚本化」）

六阶段串行驱动 + 新鲜度跳步（spec 比产物新才重跑贵阶段）：
  base(瓦片拼接/洗纸/水面/路线) → overview(总览 SVG+面板 HTML) → beats(区域底图+标注)
  → states(720p states / --final 时加 4K states4k) → anim(720p 粗剪 / --final 4K ANIM_S2=1.5)
  → fx(决策动效 cross/gray/half，spec.fx 存在才跑，FX_S2 同档；EP10 起）

用法:
  python3 packages/guide_map/run_pipeline.py <spec.json> <workdir> <outdir> [选项]
  （或 ruyi-map guide run <spec.json> <workdir> <outdir> [选项]）
选项:
  --final            终版模式：states4k + ANIM_S2=1.5 / FX_S2=1.5 4K 视频（默认 720p 粗剪）
  --jobs a,b,c       anim 只渲指定产物（默认 reveal,beats,s6card 全渲；单卡片= --jobs s6card）
  --force            无视新鲜度全部重跑
  --check            只打印执行计划与新鲜度判定，不执行
  --qa               末尾对产出 mp4 跑 qa_letterbox 黑带均匀度硬闸
前置（缺失即报错退出，不半成品）:
  瓦片缓存 <proj>/map/data/sat/14/（fetch_sat_tiles.py 抓取）、locationsFile、手描 waters（spec.waters.file）、
  node + playwright-core（仓根 npm install && npm run setup）
判例: states/anim 是最贵两步（playwright 截图+PIL 逐帧），base/overview/beats 秒级确定性每次全跑；
      render_states 8377 端口串台已根治（哨兵校验），并发多项目安全。
"""
import os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

def mtime(p):
    return os.path.getmtime(p) if os.path.exists(p) else 0

def newest_in(d, suffix=".png"):
    if not os.path.isdir(d):
        return 0
    return max([mtime(os.path.join(d, f)) for f in os.listdir(d) if f.endswith(suffix)] + [0])

def run(stage, cmd, env=None, check=False):
    line = " ".join(cmd)
    print(f"\n=== [{stage}] {line}", flush=True)
    if check:
        return 0
    t0 = time.time()
    r = subprocess.run(cmd, cwd=REPO_ROOT, env=env or os.environ.copy())
    if r.returncode != 0:
        print(f"✗ [{stage}] 失败 rc={r.returncode}——停线（半成品不往下传）", flush=True)
        sys.exit(r.returncode)
    print(f"=== [{stage}] ok {time.time()-t0:.0f}s", flush=True)
    return 0

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a[2:] for a in sys.argv[1:] if a.startswith("--")}
    if len(args) < 3:
        print(__doc__)
        sys.exit(1)
    spec, workdir, outdir = args[0], args[1], args[2]
    final = "final" in flags
    force = "force" in flags
    check = "check" in flags
    jobs = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--jobs=")), "reveal,beats,s6card")
    for f in (spec,):
        if not os.path.exists(f):
            print(f"✗ spec 不存在: {f}")
            sys.exit(1)
    import json
    sp = json.load(open(spec))
    proj = sp.get("proj") or os.path.dirname(os.path.abspath(spec))
    # —— 前置自检（缺料不半成品）——
    loc = sp.get("locationsFile")
    loc_path = os.path.join(proj, loc) if loc and not os.path.isabs(loc) else loc
    tiles = os.path.join(proj, "map", "data", "sat", "14")
    missing = []
    if not loc_path or not os.path.exists(loc_path):
        missing.append(f"locationsFile {loc_path}")
    if not os.path.isdir(tiles):
        missing.append(f"瓦片缓存 {tiles}")
    if not any(os.path.exists(os.path.join(workdir, f)) for f in ("waters_hand.json",)) and sp.get("waters", {}).get("file"):
        wf = sp["waters"]["file"]
        if not os.path.exists(os.path.join(proj, wf)) and not os.path.exists(wf):
            missing.append(f"手描水面 {wf}")
    if missing:
        print("✗ 前置缺料：\n  " + "\n  ".join(missing) + "\n先按 README「与新项目对接」备料")
        sys.exit(1)
    os.makedirs(workdir, exist_ok=True)
    os.makedirs(outdir, exist_ok=True)

    spec_mt = mtime(spec)
    py = sys.executable
    S = lambda s: os.path.join(HERE, s)

    # 1-3) 构建期：秒级确定性，每次全跑
    run("base", [py, S("build_base.py"), spec, workdir], check=check)
    run("overview", [py, S("build_overview.py"), spec, workdir], check=check)
    run("beats", [py, S("build_beats.py"), spec, workdir], check=check)

    # 4) states：spec 比状态帧新才重截（贵）
    st_dir = os.path.join(workdir, "states")
    st4k_dir = os.path.join(workdir, "states4k")
    need_states = force or spec_mt > newest_in(st_dir)
    need_4k = final and (force or spec_mt > newest_in(st4k_dir))
    if need_states:
        run("states", [py, S("render_states.py"), spec, workdir], check=check)
    else:
        print("--- [states] 新鲜，跳过（--force 重跑）")
    if need_4k:
        run("states4k", [py, S("render_states.py"), spec, workdir, "--4k"], check=check)
    elif final:
        print("--- [states4k] 新鲜，跳过（--force 重跑）")

    # 5) anim：状态帧比视频新才重渲（最贵）
    anim_env = os.environ.copy()
    anim_env["ANIM_S2"] = "1.5" if final else "1.0"
    src_dir = st4k_dir if final else st_dir
    outs = {"reveal": "reveal.mp4", "s6card": "s6card.mp4", "fullcard": "fullcard.mp4"}
    want = jobs.split(",")
    todo = []
    for j in want:
        if j == "beats":
            todo.append(j)
            continue
        out_mp4 = os.path.join(outdir, outs.get(j, f"{j}.mp4"))
        # states 本轮将重跑 → 其产物必然比 mp4 新，anim 必须跟跑（全新项目 0>0 误判「新鲜」修复）
        if force or need_states or (final and need_4k) or newest_in(src_dir) > mtime(out_mp4):
            todo.append(j)
        else:
            print(f"--- [anim:{j}] 新鲜，跳过（--force 重跑）")
    if "beats" in want and force:
        pass
    if todo:
        run("anim", [py, S("render_anim.py"), spec, workdir, outdir, ",".join(todo)], env=anim_env, check=check)

    # 6) fx（决策动效 cross/gray/half，EP10 起）：底=states/v7_full，spec.fx 存在才跑；
    #    新鲜度=spec 或 states 比 fx 产物新（states 重跑后 fx 必须重渲，README 判例 19）
    if sp.get("fx"):
        fx_env = os.environ.copy()
        fx_env["FX_S2"] = "1.5" if final else "1.0"
        fx_names = [k for k in ("cross", "gray", "half") if k in sp["fx"]]
        fx_todo = [k for k in fx_names
                   if force or max(spec_mt, newest_in(src_dir)) > mtime(os.path.join(outdir, f"{k}.mp4"))]
        if fx_todo:
            run("fx", [py, S("fx_decision.py"), spec, workdir, outdir, ",".join(fx_todo)], env=fx_env, check=check)
        else:
            print("--- [fx] 新鲜，跳过（--force 重跑）")

    if "qa" in flags:
        for j in want:
            for f in ([outs[j]] if j in outs else []):
                mp4 = os.path.join(outdir, f)
                if os.path.exists(mp4):
                    run("qa_letterbox", [py, os.path.join(REPO_ROOT, "packages/render_core/python/frame_qa.py"), mp4], check=check)
    print("\n✔ 管线完成" + ("（--check 干跑，未执行）" if check else ""))

if __name__ == "__main__":
    main()
