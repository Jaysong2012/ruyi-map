# CONTRIBUTING

欢迎贡献。先读 `docs/CAPABILITY_MATRIX.md` 理解管线分工，再读 `docs/EVOLUTION.md` 理解演进机制。

## 环境

```bash
pip install -e .          # python 侧（numpy/Pillow/jsonschema + ruyi-map 命令）
npm install && npm run setup   # node 侧（playwright-core + chromium）
ruyi-map doctor           # 自检全绿再动手
```

## 铁律

1. **确定性是资产**：渲染器时间语义必须是 t 的纯函数，禁 `Math.random`（用固定种子）。
2. **数据必须真实**：坐标/边界/轨迹来自公开数据源（`docs/DATA_SOURCES.md`），
   禁手估坐标、禁虚构地理事实；程序渲染不得伪装成观测或实拍。
3. **判例入册必配 gate**：可自动判断的规则写进 `tests/gates/`。
4. **无私货**：不提交内网地址/本机绝对路径/系统字体名（`gate_no_private_residue` 会拦）；
   中文渲染走打包字体注册表（`packages/render_core/python/fonts.py`）。
5. **瓦片/缓存/渲染产物不进 git**；example 必须能用 README 的命令从零重建。

## 提交前

```bash
ruyi-map check                                # 全部 QA 闸门
python3 -m unittest discover -s packages/map_studio/tests   # map_studio 单测
```

## PR 范围纪律

一个 PR 只做一件事：新 program / 新 preset / 新 gate / bug 修复。
渲染输出语义变化必须在 CHANGELOG 写明（major/minor 规则见 docs/EVOLUTION.md）。
