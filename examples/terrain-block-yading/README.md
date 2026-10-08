# terrain-block-yading — 3D 地形沙盘示例（E 管线）

真实 DEM 地形块 + 卫星贴图 + 路线描金 + POI 标注的程序渲染（Three.js，确定性：同 spec 同帧）。
本例取景新疆喀纳斯区域（z12 DEM，约 1.05°×0.58°），演示 `terrain_block` 的
无路线模式：相机样条 + routeLines 描路 + pois 标注 + 标签常显。

## 跑通

```bash
# ① 抓地形数据（约 40MB：Terrarium DEM + Esri 影像；海外源可能需自备代理）
python3 packages/scene3d/fetch_terrain_block.py \
  examples/terrain-block-yading/data 12 \
  86.572265625 87.626953125 48.4000324961068 48.980216985374994

# ② 渲染（8.5s @30fps，rough 档可把 canvas 改小提速）
node packages/scene3d/render_scene.mjs examples/terrain-block-yading/scene.json
# 产物：examples/terrain-block-yading/.work/scene.mp4
```

## 关键参数（判例沉淀）

| 参数 | 本例 | 说明 |
|---|---|---|
| `exaggeration` | 3 | 垂直夸张比。**全省级大地块用 28 是可信高墙档；45=刀片墙判死**；本例是小区域丘陵取 3 |
| `blur`/`blurPasses` | 4/4 | 高程场箱式模糊抛光（去 DEM 采样锯齿） |
| `step` | 3 | DEM 降采样步长（网格密度与加载量平衡） |
| `colorMode` | `sat` | 卫星贴图（`art`=按海拔分带艺术色） |
| `camPts`/`lookPts` | 样条点 | 相机/注视点 CatmullRom 样条（场景单位） |
| `routeLines` | 128 点 | 贴地描线 `{pts,t0,t1,color,width,lift,onTop}` |
| `pois` | 4 个 | 标注钉 `{name,lon,lat,color,labelColor,scale,dx,dy}` |

路线叙事模式（`routes:true`）需额外注入 `wps/flight/origin/airport/finale` 五项
（字段见 `packages/scene3d/PROGRAMS.md`）；4K 出片用 `layout:[1280,720]` + `canvas:[3840,2160]`
（deviceScaleFactor 自动 =3，DOM 文字 3x 栅格化锐利）。
