# CAPABILITY_MATRIX — 地图能力选择器

> 「这个镜头要用哪条管线」的唯一入口。先在这里选管线，再读对应手册。
> **第一原则：地图形态服从信息目标，没有「更高级」的地图只有「更对」的地图。**
> 要体现海拔差→3D 地形是正解；要体现时刻表→时刻路线平面图是正解；要体现城市肌理→城市 3D。
> 为炫技上 3D、让形式压过信息，判死。

## 选择器（按镜头要回答的问题路由）

| 镜头要回答的问题 | 管线 | 手册 | 入口命令 |
|---|---|---|---|
| 事件在哪发生（台风/地震/战线/航线地理） | **A. 2D 地理可视化** | `docs/craft/MAP_2D.md` | `ruyi-map bake map/cloud/event` |
| 路线怎么走（攻略行程/交通/海拔叙事） | **B. 3D 攻略路线** | `packages/map_studio/README.md` + `docs/craft/FOLLOW_ROUTE.md` | `ruyi-map route init-route/build/render-route` |
| 一个地点长什么样（hero 定帧/地形质感） | **C. Blender 自然地形** | `packages/map_studio/README.md` v1 节 | `ruyi-map still init/prepare/render` |
| 机制/尺度/关系是什么（轨道/剖面/落差沙盘） | **D. 3D 程序场景** | `docs/craft/SCENE_3D.md` + `packages/scene3d/PROGRAMS.md` | `ruyi-map scene render` |
| 全省/大地块的落差对比（海拔墙/剖面） | **E. terrain_block 沙盘** | `docs/craft/TERRAIN_BLOCK.md` | `ruyi-map scene render`（program=terrain_block） |
| 城市怎么呈现（楼宇/水面/地标） | **B 的城市预设** | `packages/map_studio/README.md` 城市节 | urban-bright / noir-gold 预设 |
| 一天怎么排（时刻表攻略·总览+推进） | **G. 卫星洗纸时刻表地图** | `packages/guide_map/README.md` | `ruyi-map guide run`（一条命令） |

**判断式**：观众要「地理事实」→ A；要「行程体感」→ B/E；要「地点质感」→ C；要「机制理解」→ D/E；要「一天怎么排」→ G。一条片可混用（如 E 沙盘 + B 的城市数据技巧 + 实拍 hero）。

另：**HERO_MIX 混剪**（Blender hero 定帧 → MapLibre 跟拍缝合）见 `docs/craft/HERO_MIX.md`——**未实战验证**，属实验性工作流。

## 各管线一句话与铁律

- **A · 2D 地理可视化**：真实卫星底图 + 精确边界/路径/云系。铁律=**坐标是命脉**（投影实证法+sidecar 制度）。
- **B · 3D 攻略路线**（MapLibre）：数据三件套（locations/routes/storyboard）→ compiled.json 契约 → 逐帧确定性渲染。跟拍模式贴地元素全 GL 层，禁双轨投影。
- **C · Blender 自然地形定帧**：hero 级地形质感（CYCLES+PBR+谷雾），只能定帧/短镜头。PBR 管微观质感、DEM 管真实地形、卫星图管地理变化，三者不得互相替代。
- **D · 3D 程序场景**：机制/尺度/关系的「诚实代码图解」。判死线=水/火/流体等日常经验内的物理过程，无真实素材锚不立项。
- **E · terrain_block 沙盘**：真实 DEM+卫星贴图+程序收边的大面积海拔叙事。exaggeration 28=可信高墙档，45=刀片墙判死。
- **G · 时刻表攻略地图**：洗纸卫星底+时刻表面板+路线三态+决策动效。判例 24 条全录于包 README。

## 公共纪律（跨管线）

- 渲染确定性：同 spec 同帧；GPU 重任务**串行**（同 program 并行渲=共享帧目录+端口打架）。
- 改 spec 必清产物缓存再重渲（断点续跑混版）。
- 瓦片/DEM 改动后必须重编译并抽查 ground 字段非 None。
- 联系表必烙时间戳；构图对比一律数值 diff，禁跨分辨率肉眼比对。
- 海外数据源需自备代理（`https_proxy` 环境变量）；示例瓦片不进 git，fetch 命令重建。
