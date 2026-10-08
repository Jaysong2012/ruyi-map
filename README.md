# ruyi-map — 视频级地图镜头生产线

把地理数据变成视频可用的地图镜头：真实 DEM / 卫星影像 / 行政边界 / 路网 / 时刻表进，
确定性逐帧渲染出 mp4 与 4K 状态帧。六条管线覆盖从「事件在哪」到「一天怎么排」的全部地图镜头形态，
全部经已发布作品实战验证。

> **English**: ruyi-map is a map-cinematography toolkit for video creators. Six spec-driven
> pipelines (2D geo-events, 3D route follow-cam, Blender terrain stills, procedural 3D scenes,
> terrain-block sandboxes, timetable guide maps) turn real geographic data (DEM / satellite /
> boundaries / road networks) into deterministic, frame-accurate video clips. Docs are primarily
> in Chinese; each package README has command examples that read fine in any language.
> MIT licensed. Quick start: `pip install -e . && npm install && npm run setup && ruyi-map doctor`.

## 能力选择器（什么镜头用哪条管线）

| 镜头要回答的问题 | 管线 | 入口 | 手册 |
|---|---|---|---|
| 事件在哪发生（台风/战线/航线） | A · 2D 地理可视化 | `ruyi-map bake` | `docs/craft/MAP_2D.md` |
| 路线怎么走（行程/交通/海拔） | B · 3D 攻略路线 | `ruyi-map route` | `docs/craft/FOLLOW_ROUTE.md` |
| 这地方长什么样（hero 定帧） | C · Blender 地形 | `ruyi-map still` | `packages/map_studio/README.md` |
| 机制/尺度/关系是什么 | D · 3D 程序场景 | `ruyi-map scene` | `docs/craft/SCENE_3D.md` |
| 落差有多大（全省海拔墙） | E · terrain_block 沙盘 | `ruyi-map scene` | `docs/craft/TERRAIN_BLOCK.md` |
| 一天怎么排（时刻表攻略） | G · 洗纸时刻表地图 | `ruyi-map guide` | `packages/guide_map/README.md` |

**第一原则：地图形态服从信息目标，没有「更高级」的地图只有「更对」的地图。**
完整路由与设计哲学：`docs/CAPABILITY_MATRIX.md`。

## 安装

```bash
git clone <repo> && cd ruyi-map
pip install -e .                 # python 3.10+（numpy/Pillow/jsonschema）+ ruyi-map 命令
npm install && npm run setup     # playwright-core + chromium（逐帧渲染引擎）
ruyi-map doctor                  # 自检：node/chromium/ffmpeg/字体 全绿
```

外部依赖：`ffmpeg`+`ffprobe`（必需）、`blender`（仅 C 管线需要）。
海外数据源（Esri/AWS S3/GIBS）可能需自备代理：`export https_proxy=http://<proxy>:<port>`。

## 五分钟跑通

```bash
# G 管线教学例（瓦片随仓，全程离线）：稻城亚丁时刻表攻略地图
python3 packages/guide_map/run_pipeline.py \
  examples/guide-map-yading/guide_map_spec.json \
  examples/guide-map-yading/.work/gmap \
  examples/guide-map-yading/.work/gmap/anim --qa
# 产物：状态帧 states/v7_*.png + 视频 anim/*.mp4（reveal 描路/beat 推进/s6card 收藏卡）

# D 管线离线样例：太阳系轨道图 8s
node packages/scene3d/render_scene.mjs examples/scene3d-sampler/solar_system_map.json
```

更多：`examples/guide-map-altay/`（G 全要素：rawGeo 真实路网+决策动效）、
`examples/terrain-block-yading/`（E 沙盘）、`examples/geo-event-typhoon/`（A 事件播报模板）、
`packages/map_studio/examples/`（B 三个夹具，build/qa 离线可跑，渲染需先 fetch-tiles）。

## 仓库结构

```
packages/
  render_core/   共享渲染基建：chromium 启动/帧服务器/HTML 渲染器/字体注册表/帧 QA
  map_studio/    B+C 管线：MapLibre 3D 路线（数据三件套→compiled 契约→逐帧渲染）+ Blender 定帧
  geo_bake/      A 管线：底图烘焙/云系层/事件播报渲染（坐标 sidecar 制度）
  scene3d/       D+E 管线：Three.js 程序场景 17 个 program + DEM 数据抓取
  guide_map/     G 管线：时刻表攻略地图六阶段一条命令
docs/            能力选择器 / 数据源合规 / 演进机制 / craft 工艺手册六册
examples/        每管线可跑案例（含 README 与重建命令）
tests/gates/     QA 闸门注册表（ruyi-map check 一键全量）
```

## 工程信念（三条不可协商）

1. **数据必须真实**：坐标是命脉——投影实证法+sidecar 制度，禁手估坐标、禁虚构地理事实；
   程序渲染是「诚实的代码图解」，不得伪装成观测或实拍。
2. **确定性是资产**：同 spec 同帧（`__setT(t)` 纯函数）；黄金基线数值 diff 回归；
   判例入库必配可执行闸门（`ruyi-map check`）。
3. **开箱即用**：examples 都能用 README 命令从零重建；瓦片/缓存不进 git；
   中文渲染走打包 OFL 字体，无系统字体依赖。

## 文档地图

- 选管线 → `docs/CAPABILITY_MATRIX.md`
- 怎样算好（工艺判例）→ `docs/craft/`（FOLLOW_ROUTE / TERRAIN_BLOCK / SCENE_3D / MAP_2D / GUIDE_MAP_DESIGN / HERO_MIX）
- 数据源与署名 → `docs/DATA_SOURCES.md` + `ATTRIBUTION.md`
- 演进与贡献 → `docs/EVOLUTION.md` + `CONTRIBUTING.md`

## License

MIT（代码）。数据与素材的署名要求见 `ATTRIBUTION.md`。
