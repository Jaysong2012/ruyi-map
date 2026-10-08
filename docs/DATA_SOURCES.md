# DATA_SOURCES — 数据源与合规

ruyi-map 全部使用公开数据源。下载时遵守各源服务条款；发布产物时按本表署名。
海外源（AWS S3、NASA GIBS、部分地区 Esri 节点、jsdelivr）可能需自备代理：
`export https_proxy=http://<your-proxy>:<port>`（工具链尊重 `https_proxy`/`http_proxy` 环境变量）。

## 瓦片与高程

| 源 | 用途 | 地址模板 | 条款 |
|---|---|---|---|
| Esri World Imagery | 卫星底图瓦片（guide_map z14 / map_studio sat / fetch_terrain_block 影像） | `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` | Esri 许可，产物需署名 "Source: Esri, Maxar, Earthstar Geographics"（渲染器 credit 已内置） |
| AWS Terrarium (Mapzen) | DEM 高程瓦片（terrain_block / map_studio dem） | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | 开放数据（SRTM 等汇编），编码 h=R·256+G+B/256−32768 |
| NASA GIBS | 静态底图+云图（geo_bake） | `https://gibs-a.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi?...` | 公有领域，署名 NASA GIBS；葵花9 云图署名 JMA/NASA GIBS |
| OpenStreetMap | 矢量底图备选（map_bake xyz vector） | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | ODbL，署名 © OpenStreetMap contributors |
| OpenTopoMap | 地形底图备选 | `https://tile.opentopomap.org/{z}/{x}/{y}.png` | CC-BY-SA |
| CARTO dark | 暗色底图备选 | `https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png` | CARTO 条款 |

## 边界与路网

| 源 | 用途 | 条款 |
|---|---|---|
| 阿里云 DataV areas_v3 | 中国省界/国界（`https://geo.datav.aliyun.com/areas_v3/bound/{code}.json`）；十段线=100000_full unnamed 要素（已收编包内 `packages/geo_bake/data/ninedash.geojson`） | DataV 数据服务条款 |
| NaturalEarth 110m | 外国界 | 公有领域 |
| OSM Overpass | 水面/路网候选（`https://overpass-api.de/api/interpreter`） | ODbL；超时不可信时水面用卫星图阈值分割兜底（guide_map 判例 23） |

## 纹理与字体（随仓分发）

| 资产 | 来源 | 许可 |
|---|---|---|
| `assets/space/textures/` 行星贴图 | Solar System Scope（SSS）/ NASA SVS CGI Moon Kit / NASA New Horizons | SSS **CC BY 4.0**（署名 "Solar System Scope"）；NASA 公有领域 |
| `assets/three/three-0.185.1.js` | three.js | MIT |
| `assets/viz/waternormals.jpg` | three.js examples 水面法线贴图 | MIT |
| `assets/fonts/` 六款字体 | 霞鹜文楷 / 得意黑 / 站酷庆科黄油体 / 马善政 / Space Grotesk | 全部 **SIL OFL 1.1**（全文 `assets/fonts/OFL.txt`；用字体创作的作品无限制无需署名） |
| MapLibre GL JS v4.7.1（vendored） | maplibre-gl | BSD-3 |

## 可选外部资产（不随仓，文档指引）

- Poly Haven HDRI/植被模型（Blender still 管线 verdant-cinematic 预设引用）：**CC0**，
  自 https://polyhaven.com 下载后放入项目 `.work/` 并在 scene.json 引用；缺失时代码自动回退。

## 缓存纪律

- 瓦片/数据缓存一律不进 git（`.gitignore` 已覆盖）；examples 的数据用各自 README 的 fetch 命令重建。
- `geo_bake` 的边界 GeoJSON 缓存在 `~/.cache/ruyi-map/`（`RUYI_MAP_CACHE` 可覆盖）。
- 抓瓦片请控制并发（工具默认 8 线程）并复用缓存，别给公共服务源施压。
