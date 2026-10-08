# guide-map-yading — 时刻表攻略地图·教学示例（G 管线）

稻城亚丁两日攻略地图的生产 spec：多段步行链（25 条 walk + 2 条 bus）、
双区域 beat、收藏卡 fullcard。**瓦片已随仓携带（2.9MB），全程离线可跑**——
这是上手 guide_map 管线的第一站。

```bash
python3 packages/guide_map/run_pipeline.py \
  examples/guide-map-yading/guide_map_spec.json \
  examples/guide-map-yading/.work/gmap \
  examples/guide-map-yading/.work/gmap/anim --qa
```

产物：`states/v7_*.png`（总览状态机 base/reveal_1..N/s6/full + beat 帧）、
`anim/*.mp4`（reveal 金线描路 / beat 行进徽章 / s6card 收藏卡）。

教学注记：本例为精简版，未含手描水面层（`waters` 为可选层，无则不叠）；
完整要素（rawGeo 真实路网 / fx 决策动效 / 水面）见 `guide-map-altay` 例。
