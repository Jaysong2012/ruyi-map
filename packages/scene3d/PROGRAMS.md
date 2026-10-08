# render_scene.mjs — 程序场景索引（PROGRAMS）

`render_scene.mjs <spec.json>`：spec 驱动 → Three.js 逐帧确定性渲染（同 spec 同帧）→ ffmpeg 出片。

## spec 通用字段

```json
{
  "out": ".work/out.mp4",          // 相对 spec 文件目录
  "canvas": [1920, 1080], "fps": 60, "durationMs": 17000, "crf": 18,
  "program": "<下表之一>", "params": { ... },
  "layout": [1280, 720],           // 可选 4K：viewport=layout，deviceScaleFactor=canvas/layout（DOM 文字超采样锐利）
  "antialias": true,
  "motionBlur": {"samples": 3, "shutter": 0.5},  // 子帧运动模糊（opt-in）
  "keepFrames": false
}
```

数据类 program 的 `params.base` 一律指向 `fetch_terrain_block.py` 产物目录
（`meta.json` + `heights.f32` + `surface.jpg` + `mask.bin`），服务器相对路径
（如 `examples/terrain-block-yading/data`）。**无内置默认数据——必须显式注入。**

## program 一览

### 宇宙/地球系（纹理走 assets/space/textures，离线可跑）

| program | 用途 | 关键 params |
|---|---|---|
| `lights_out` | 地球日照→熄灯→夜景灯光浮现 | dimStartMs/dimMs/blackHoldMs/nightRiseMs/rotY0 |
| `wandering_earth` | 银河背景冷暗地球缓漂+缓拉 | — |
| `pacific_dive` | 真实纹理地球俯冲太平洋→程序海面 | — |
| `tidal_lock` | 地月潮汐锁定三幕演示 | — |
| `solar_system_map` | 太阳系俯视轨道图 | focus/push/orbitPace |
| `cme_storm` | 日冕物质抛射直击地球 | — |
| `eclipse_geometry` | 血月机制两幕（影子罩月/大气折红光） | — |
| `red_ring_earth` | 月面视角红环地球海报帧 | — |
| `terminator_earth` | 晨昏线地球侧光 | — |
| `epic_journey`（别名 `voyager_helio`） | 太阳系→日球层穿越 | 相位锚点/引力弹弓/日球层膜参数（EPIC_JOURNEY_DEFAULTS） |

### 地形系（需 params.base 地形数据包）

| program | 用途 | 关键 params |
|---|---|---|
| `jilong_flyover` | 真实 DEM 峡谷飞行 | base/exaggeration(1.8)/step(2)/camFov(50) |
| `huashan_sun` | DEM 山岳+太阳一日轨迹 | base |
| `weihe_valley` | 非对称河谷贴河面跟拍 | base |
| `weihe_erosion` | 河流冲蚀概念（掏槽崩塌/沙洲淤高） | base |
| `terrain_block` | **全省地形块沙盘**（见下） | base+塑形/相机/路线五件套 |
| `flood_block` | 海平面上升三幕（高程场+水面 mesh+城市海拔钉） | base/水位时刻表 |
| `arctic_wall` | 冷空气围墙塌口南漫 | wallLat/breachLon/targetLat/shrinkT/breachT |

### 其他

| program | 用途 |
|---|---|
| `tower_showcase` | 程序化塔楼/建筑展台环绕 |

## terrain_block 参数字典（最厚的一条）

- **地形**：`base`（必填）/ `exaggeration`（垂直夸张，**全省地块 28=可信档，45=刀片墙判死**）/ `step`（DEM 降采样）/ `blur`+`blurPasses`（抛光）/ `edgeFall`（边缘径向衰减格数，默认 10，局部高山地块需 22-26）/ `colorMode`（`sat` 卫星贴图 / `art` 海拔分带艺术色）/ `shadows`
- **相机**：`camPts`/`lookPts`（CatmullRom 样条）/ `godCam0/1`+`godLook0/1`（上帝视角定场）/ `camFov`（44）/ `camNear`（局部地块要 0.002）/ `sunPos`
- **时序**：`timeline{fly,drv,end}`（分镜时刻表秒）/ `driveKeys:[[t,frac]]`（车速分段线性，对齐旁白句界）/ `driveOnly` / `driveFracCap` / `finaleAt` / `flightBack` / `diveIn` / `ringAt:{wpsIdx:秒}`
- **路线模式**（`routes:true` 时五项必填）：
  - `wps`：站点链 `[{name,lon,lat,alt?,big?,ring?:sleep|nosleep,chip?,card?}]`
  - `flight`：`{from:{lon,lat,alt}, mids:[[lon,lat,h]...], to:{lon,lat,alt}}`（末段必须拉平，垂直冲下判死）
  - `origin`：起点城市 `{lon,lat}`（金环/返程锚点）
  - `airport`：目的地机场 `{lon,lat}`（红环/直飞终点；`airportLabel`=对比标签文案）
  - `finale`：终章点 `{lon,lat,chip?,card?}`
- **免路线模式**（`routes:false`）：`routeLines:[{pts:[{lon,lat}],t0,t1,color,emissive,width,npts,lift,onTop}]` + `pois:[{name,lon,lat,color,labelColor,scale,dx,dy}]` + `labelsAlways` / `pinLength` / `poiScale` / `poiLabelScale`
- **元素开关**：`hero` / `chips` / `profileCard` / `profileOnly` / `stationRings` / `labelsAlways` / `hud` / `wpLabels`
