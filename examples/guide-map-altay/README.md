# guide-map-altay — 时刻表攻略地图·全要素示例（G 管线）

新疆喀纳斯一日攻略地图的完整生产 spec：rawGeo 真实路网描路（10 段四色放射）、
fx 决策动效三件套（cross 打叉 / gray 劝退 / half 半亮）、rotate90:false 取景、
行进徽章、收藏卡。数据为已发布作品的真实生产数据。

## 跑通

```bash
# ① 抓 z14 瓦片（约 21MB，需网络；已抓过会跳过）
python3 packages/guide_map/fetch_sat_tiles.py examples/guide-map-altay/guide_map_spec.json

# ② 一条命令出全部产物（粗剪档）
python3 packages/guide_map/run_pipeline.py \
  examples/guide-map-altay/guide_map_spec.json \
  examples/guide-map-altay/.work/gmap \
  examples/guide-map-altay/.work/gmap/anim --qa

# ③ 终版（states4k + 4K 视频）
python3 packages/guide_map/run_pipeline.py \
  examples/guide-map-altay/guide_map_spec.json \
  examples/guide-map-altay/.work/gmap \
  examples/guide-map-altay/.work/gmap/anim --final --qa
```

产物：`states*/v7_*.png`（状态帧）、`anim/{reveal,beat_*,s6card,fullcard,cross,gray,half}.mp4`。
评论区收藏卡 = `states4k/v7_s6.png` 直裁左上内容区（勿视频抽帧）。

## 文件

| 文件 | 作用 |
|---|---|
| `guide_map_spec.json` | 主 spec（575 行；rawGeo 坐标链已抽外部文件） |
| `rawGeo.geojson` | 真实路网坐标链 10 段（main 金 / spoke_* 异色 / walk dash） |
| `map/locations.json` | 站点坐标 |
| `waters_hand.json` | 手描水面多边形（喀纳斯湖/河） |

## spec 要点

- `fx.cross{a,b}`：两站间不连通打叉；`fx.gray{route,stop,stopN,stopName,labelAt,zoom}`：
  支线+徽标+站名灰化劝退（保持段连续推近）；`fx.half`：半亮放行。
- `routes.rawGeoFile`：外部坐标链文件（相对 spec 目录），与站点链同 namespace。
- 判例全集见 `packages/guide_map/README.md`（24 条，全部踩过勿再犯）。
