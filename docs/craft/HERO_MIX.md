# HERO_MIX — Blender hero 定帧 × MapLibre 跟拍混剪（实验性）

> **状态：未实战验证。** 本工作流参数为设计值，首个采用项目验证后才转 DEFAULT。

## 形态

风景片开场：v1 Blender 电影级 hero 定帧（CYCLES+PBR+谷雾，2-3s）→ dissolve →
v2 MapLibre 3D 跟拍进入行程叙事。两条管线**数据源同源**（同一 DEM 窗口+同一卫星影像），
hand-off 机位对齐，缝合处观众读不出换引擎。

## 工艺参数

- **数据同源**：Blender 场景的 DEM/texture 与 MapLibre 瓦片必须同一区域同一来源
  （`ruyi-map still prepare` 的裁窗 = map_studio project.json 的 bounds）。
- **hand-off 机位容差**：Blender 末帧机位（方位/俯仰/视场）与 MapLibre 首帧相机
  （bearing/pitch/zoom）换算后角度差 <3°，构图主体屏幕位置差 <5% 画幅。
- **缝合**：dissolve 300-400ms；严禁硬切（引擎质感差异会跳出）。
- **调色对齐**：Blender 出片 LUT 向 MapLibre grade 靠（亮调青绿攻略线=green-lush-mountains 方向）。

## 什么时候用

只用于「地点质感就是卖点」的自然风景片开场。攻略信息片不需要——直接 B/G 管线起。
