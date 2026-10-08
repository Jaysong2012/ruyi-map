# examples — 可跑案例索引

每个案例含 README + spec + 重建命令。**判例纪律：瓦片/缓存/渲染产物不进 git，
案例必须能用 README 命令从零重建**（guide-map-yading 例外：2.9MB 瓦片随仓，保证零基础用户第一条命令就能跑）。

| 案例 | 管线 | 网络需求 | 演示点 |
|---|---|---|---|
| `guide-map-yading/` | G 时刻表攻略地图 | **离线**（瓦片随仓） | 多段步行链/双 beat/收藏卡；教学第一站 |
| `guide-map-altay/` | G 全要素 | 抓瓦片 ~21MB | rawGeo 真实路网四色放射/fx 决策动效三件套/inset |
| `terrain-block-yading/` | E 地形沙盘 | 抓 DEM+影像 ~40MB | terrain_block 无路线模式：相机样条/routeLines/pois |
| `scene3d-sampler/` | D 程序场景 | **离线**（纹理随仓） | lights_out/solar_system_map/arctic_wall 三代表 program |
| `geo-event-typhoon/` | A 地理事件 | 底图+云图 | 填数即用的事件播报模板（轨迹须换真实机构数据） |
| `../packages/map_studio/examples/` | B 攻略路线 | 渲染需抓瓦片 | wulingyuan 跟拍/jiuzhaigou/huangshan 三夹具，build/qa 离线 |
| `../packages/map_studio/examples/huangshan/` | C Blender 定帧 | 自备 DEM/贴图 | v1 场景契约（Blender 必需） |

冒烟验证矩阵（发布前过一遍）：

```bash
ruyi-map doctor                                    # 环境全绿
ruyi-map check                                     # QA 闸门全过
python3 -m unittest discover -s packages/map_studio/tests   # B/C 单测 7/7
python3 packages/guide_map/run_pipeline.py examples/guide-map-yading/guide_map_spec.json \
  examples/guide-map-yading/.work/gmap examples/guide-map-yading/.work/gmap/anim --qa
node packages/scene3d/render_scene.mjs examples/scene3d-sampler/solar_system_map.json
```
