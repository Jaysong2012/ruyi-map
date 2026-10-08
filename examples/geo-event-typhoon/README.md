# geo-event-typhoon — 地图事件播报示例（A 管线）

台风/洪水/山火/战线类「事件在哪发生」的确定性渲染流程：底图一次烘焙 → 事件/轨迹/镜头写进
`event.json` → 逐帧渲染出片。**本目录是填数即用的模板**：把 `event.json` 里的标题、
`factCutoff`、`track`（真实机构路径点）、`labels` 换成你的事件数据即可。

## 生产顺序

```bash
# ① 底图+行政边界烘焙（需网络：Esri 卫星瓦片 / DataV 边界 / NaturalEarth）
ruyi-map bake map examples/geo-event-typhoon/map_bake.json

# ②（可选，云系题材）GIBS 云图拉取 + 对齐到底图
ruyi-map bake himawari "2026-09-01 00:00" .work/gibs/source.jpg 99 9 139.5 40.5
ruyi-map bake cloud examples/geo-event-typhoon/cloud_bake.example.json

# ③ 抽帧看相（rough 模式，逗号分隔秒数）
ruyi-map bake event examples/geo-event-typhoon/event.json --mode rough --frames 0,10,20

# ④ 全片渲染（final=原生 3840×2160）
ruyi-map bake event examples/geo-event-typhoon/event.json --mode final
```

## 数据纪律（继承自实战判例）

- **坐标是命脉**：渲染器只读 `map_bake` 写出的 geo sidecar（`.work/map.geo.json`），
  禁止手写像素↔经纬换算。
- `track[].at` 是成片旁白时间轴，原始观测时间存 `time`；`kind` 语义：`observed`=实测
  （实线）、`forecast`=预测与 `uncertain`=低置信（均虚线）。
- 路径点必须来自真实机构数据（JMA/CMA best track 等），占位点只是格式示例。
- 地图保持明亮清楚：渲染前自动检查 `meanLuma>=48` 且亮像素占比 `>=35%`，不合格直接终止。
- 预报机构写全名放固定图例；多机构预测=「预报分歧」，主情景须注明依据，不得虚构概率。

## 文件

| 文件 | 作用 |
|---|---|
| `map_bake.json` | 底图烘焙 spec（窗口/zoom/xyz 底图风格/边界层） |
| `cloud_bake.example.json` | 云层对齐 spec 示例 |
| `map.geo.json` | 坐标 sidecar 样例（真实产物由 ① 生成） |
| `map_profiles.json` | 地图外观档位 |
| `event.json` | 事件播报 spec（标题/镜头/轨迹/标注/时刻） |
