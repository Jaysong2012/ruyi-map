# Map Studio

独立、spec 驱动的电影级真实地图能力包，不依赖任何影片项目。v2=MapLibre 3D 攻略路线（主力）；v1=Blender 自然地形定帧（hero 质感）。

> 选管线先读 `docs/CAPABILITY_MATRIX.md（仓根 docs/）`（能力选择器：什么镜头用哪条管线）；本 README 是 B/C 两管线的完整正本。

## v2：3D 攻略路线

模型只编辑三份文件：

- `locations.json`：地点 ID、名称、经纬度和地点类型；
- `routes.json`：路线折线、交通方式及可选样式覆盖；
- `storyboard.json`：路线生长、镜头、节点解读、停留和总览的时间编排。

`project.json` 是工程模板，声明地图窗口、本地卫星/DEM 瓦片和输出规格，通常由 `init-route` 生成后固定。编译器负责引用解析、经纬度与边界校验、路线断裂检查、交通视觉语义、时间范围、路线事件互斥和规范化输出，不允许渲染器猜测导演意图。

```bash
python3 packages/map_studio/mapstudio.py init-route projects/<project>/map
python3 packages/map_studio/mapstudio.py build projects/<project>/map/project.json
python3 packages/map_studio/mapstudio.py qa projects/<project>/map/project.json
```

产物 `output/compiled.json` 是渲染后端唯一输入，并带有稳定的 `contractSha256`。相同三份输入必定产生字节等价的核心契约；项目侧不得再新增 `render_<景区>.py` 或在 HTML 中写景点名。

### 渲染与 QA

```bash
python3 packages/map_studio/mapstudio.py fetch-tiles projects/<project>/map/project.json   # 按 bounds 抓本地瓦片（海外源走代理）
python3 packages/map_studio/mapstudio.py preview projects/<project>/map/project.json --at 8.5
python3 packages/map_studio/mapstudio.py render-route projects/<project>/map/project.json --quality rough   # 720p
python3 packages/map_studio/mapstudio.py render-route projects/<project>/map/project.json --quality final   # 原生 4K
python3 packages/map_studio/mapstudio.py qa-render projects/<project>/map/project.json --quality rough
```

渲染器 `mapstudio/web/route_renderer.html` 是通用模板：只读 `compiled.json`，不含任何景区名称、坐标或场景分支（有自动测试拦截）。它提供路线按弧长生长、多交通方式分色、行进角色、节点标签与解读卡、停留脉冲与微运镜、总览拉远；相机由分期闭式求值加边界混合保证连续，不在交通切换时重建或跳变。`render.mjs` 逐帧驱动 `__setT(t)`，相同 t 必得相同帧；`qa-render` 检查帧数、缺瓦片、渲染错误、overlay 安全区与黑闪。

故事板事件语义：`route` 生长一段路线；`marker`/`callout` 在某地点显示标签或解读卡；`hold` 在停留点保持生命感（扩散光圈、呼吸核、微环绕，禁止静止假死）；`camera` 声明开场总览或显式机位；`summary` 渐进拉远形成全局总览。交通切换时上一段以低透明度留存。标签与解读卡自带边缘淡出：锚点接近画面边缘时按 DOM rect 渐隐，不会挂在屏外。

渲染器判例（迁移时实测踩出）：

1. MapLibre Marker 会重置**本体** element 的 `style.opacity`，透明度永远打在子元素上，不打在传给 `Marker({element})` 的那个节点上。
2. `cameraForBounds` 返回的 `center` 是 `LngLat` 对象不是数组，插值前必须取 `.lng/.lat`，否则 `jumpTo` 收到 NaN。
3. `querySelector('span')` 这类泛选择器在复合 DOM 里极易选中错误节点（pin 吃掉了解读卡正文），一律用带路径的具体选择器。
4. 相机连续性不靠 keyframe 对齐，而靠「分期闭式求值 + 边界 0.45s 混合」：每个分期的相机公式可自然延伸过界，交界处取两侧公式按 smoothstep 混合。

### 跟拍模式与单管线铁律（2026-09-10 张家界 D2 战役终解）

storyboard 的 `route` 事件带 `camera.follow` 即进入黄山式跟拍：

```json
{"type":"route","segment":"...","camera":{"follow":true,"pitch":60,"agl":11000,"trail":0.06,"tangentWin":0.4}}
```

- `trail`=相机拖在路线头后方（段首起点城市留画面=「从城里出发」读感）；前探 `lookAhead` 已判死（段首相机在山里=「从山里出发」）。`agl`+`pitch` 定上帝视角跟拍档（8000 太低贴地 / 11000 正解 / 14000 偏地图感）；`tangentWin` 按瞬时 °/s 选（0.4≈20°/s 是上限，0.12=114°/s 甩鞭判死）。
- **单管线铁律**：一切贴地元素（原生线/车 icon/景点 tag/解读卡/点亮/pulse）全在 GL 层由引擎投影，禁止 GL+SVG/DOM 双轨——两轨各自算投影必然不一致，相机一动就是向观众直播「飘」。DOM 只剩屏幕固定 HUD/标题/图例。`routelayer=0` 纯 SVG 仅用于锁机位总览项目（无相机运动=SVG 漂移判例不成立，且原生线高空俯瞰会被山脊切碎）。
- **路线=原生线图层**（geojson 弧长切片 setData 生长，与 journey 同度量）：draped 贴纸=地形绑定投影，定义上零漂移。生长头与车 icon 同一坐标（实测差 ~0.1m）。
- **遮挡一致性三件套**（icon 飘的终解，全部判例注释在 route_renderer.html「视线净空同步」块）：
  1. v4.7.1 symbol 层**不吃**地形遮挡且 `queryRenderedFeatures` 对 symbol 层返回空不可信（肉眼可见也空）——遮挡判定只许几何射线，禁止渲染查询；
  2. 相机位置闭式反演：视线轴距离 `D=ALTK/2^zoom`（elevation 冻结语义），相机高度=`D×cos(pitch)`、水平后移=`D×sin(pitch)` 沿 bearing 反向（`transform.cameraToCenterDistance` 实证；`center 正上方`和 `tan(pitch)` 两种误用都已判死）；
  3. 射线地形采样走 `queryTerrainElevation`（与渲染 mesh 同 tile 缓存=引擎遮挡真值同源），**v4.7.1 的 qte 返回已乘 TEX 的视觉海拔，比较时禁止再乘**；另加坡面朝向判定（heightfield 背向坡面必被邻脊遮挡=draped 线不渲染，但点射线可能通畅——背向时 icon 必须同淡）。
- **车头徽章双保险**：symbol icon（引擎投影，质感主体）+ circle 底座（draped 通道，与原生线同渲染同遮挡）——symbol 在 z12 mesh 会被引擎 LOD 剔除（720p 消失/1080p 出现=视口依赖判例），circle 底座保证「线头可见处必有标记」，小样 360 帧徽章 0 缺失。
- **信息陈设豁免净空**：tag/解读卡只受事件时间窗控制（位置由 GL 投影锁死=不飘），不做净空淡隐——景点锚点常贴崖壁（百龙下站 570m vs 身后 874m 崖=射线擦崖误杀，hold 解读拍卡消失判例）。
- **闪烁军规**（主人「车闪/聚焦时山重绘」判词后立）：
  1. 净空 verdict 翻摆只许表现为 alpha 涟漪，不许整帧隐现——visMul 交叉淡 0.8s/6 采样；
  2. **circle 底座不吃 visMul**（draped 元素引擎自管遮挡，叠自研净空只会引入误杀闪烁；f158 判例：±30m qte 梯度抓到小土丘法向判背向，但引擎同帧线头清晰可见=误杀，traveller 整帧消失=「车闪」本体——坡面朝向判定因此废弃）；
  3. **hold 显式 bearing 贴近跟拍末端切向**（默认 baseBearing 与末端切向差 78°/1.6s=54°/s 甩鞭=「聚焦时重绘感」一半本体；现 26°/2.2s≤19°/s）；
  4. **hold agl 让 zoom 全程 <14**（zoom≥14 触发 z14 瓦片换档=聚焦定格时山体锐度跳变另一半本体；agl 4800→13.87 不跨档；z13 换档发生在跟拍移动期被运动掩盖）。
- **qte 冷缓存宁显勿隐**：瓦片未加载时 qte=null 样本跳过（网格回退会过杀致 icon 整帧消失）；渲染序列缓存逐帧 warm 自校正，`--at` 单帧靠 render.mjs 慢速路径二次 `__setT`+idle 等待收敛（裸等 300ms 截图丢 icon 判例）。
- **compile 硬校验**：storyboard 事件必须按 start 升序，编译器直接报错（追加快照事件时最易踩）。

### 输入边界

位置数据只回答“点在哪里”；路线数据只回答“怎么连、采用什么交通”；编排数据只回答“什么时候展示什么”。颜色、虚实线、路线光晕、行进角色、节点默认状态、镜头插值和 QA 属于能力包。默认交通语义为：步行绿、大巴橙、索道黄虚线、地轨紫虚线、船蓝虚线、驾车红橙。

精确步道可直接写 `coordinates`；示意路线可写 `locations` 让编译器按节点连接。前者适合正式路线，后者适合方案早期。`maximumGapMeters` 用于拒绝意外断裂，不能靠渲染时补线掩盖数据问题。

完整契约见：

- `schemas/project-v2.schema.json`
- `schemas/locations-v2.schema.json`
- `schemas/routes-v2.schema.json`
- `schemas/storyboard-v2.schema.json`

最小无代码示例在 `examples/huangshan-route/`（真实步道折线）。第二个非黄山夹具 `examples/jiuzhaigou-route/` 证明：复制示例只改三份 JSON、跑 `fetch-tiles`，即可生成另一景区的 3D 路线视频，项目目录不新增 Python、HTML 或 JS。示例瓦片不进入 git，用 `fetch-tiles` 重建。

**跟拍模式标准案例 `examples/wulingyuan-follow-route/`**（2026-09-10 主人终审通过）：17s 含全部事件类型（开场建立/跟拍生长/景点 tag/走过点亮/到达拍 hold+光圈+解读卡），配套制作指导 `FOLLOW_ROUTE_GUIDE.md`（从剧本到成片 SOP：三份 JSON 语义、跟拍与到达拍配方、旁白句界节奏、渲染 QA 三连、判例速查、新目的地接入清单）。做路线预演镜头从这里起步，不要从零配。

### 渲染器能力开关与 4K 档判例

- **route 事件 `hud:false`**：关闭该段自动里程 HUD 卡（海报/净版场景要中央净空，EP3 S7 判例：HUD 烘焙进图=废图）。
- **legend 空 label 过滤**：`routes.json` 段 `label:""` 时图例不再渲染该 pill（净版不再出现空白图例块）。
- **`style.width` 线宽**：routes 段级线宽覆盖（默认 5）；剖面/总览需要更细或更粗线时用，不要在渲染器改常量。
- **QUALITY final 档=720 视口×dsf3**（曾经的炸弹：3840 视口×dsf3=11520×6480 帧必崩，2026-09-11 修复）；final 会请求更高 z 级瓦片——**DEM 缺失=平地必须补抓重渲**（mse 帧比对可定罪），**sat z15 缺失走父级回退可放行**（帧勘验无灰洞即可编码）。
- **d2 类长跟拍内存尖峰崩溃已根治（2026-09-12）**：render.mjs 崩溃自愈——任一帧截图失败即冷启动浏览器→热瓦片→续渲同帧（__setT 确定性保证同 t 同帧），`--from/--to/--resume` 支持手工分段；report 记录 crashes/relaunches 供 qa-render 审查。同役修 **dash 布尔判例**：compiler 交通语义 `dash:true` 直传 line-dasharray（须数组）→ addLayer 抛错、索道/地轨段主线层整场缺失；渲染器归一化 `dash===true→[2.5,2]`。
- **引线标注（2026-09-12，S7 遗留落地）**：marker/callout 事件 `leader:true` → 标签底边烘焙竖直引线+端点钉指向锚点（烘焙进 GL 符号图=投影锁死不飘，与自定义 offset 互斥）；标准案例 bailong callout 已开演示。总览/海报类多标签场景从此有视觉锚定。

### 城市能力（水面染色/通透度/楼宇真实感/地标识别/goldfix；南京 showcase 验证）

- **水面层 v2「染色不覆盖」**：`map.sources.water=geojson 多边形` + `map.waterStyle{color,opacity,sheen}`。主人判词：浅蓝白镜面满铺=牛奶假水判死——水体主导色是水本身青绿，天空镜面只是局部高光。深青绿低透明染色+随 zoom 衰减（高空江河保泥沙真色，低空湖面出青绿），sheen 默认 0。**inner 环 MUST 挖孔**（湖心岛/江心洲，可用 Overpass `out geom` 抓取后按正解处理）；流动/波纹判死线不变。Overpass 判例：`out geom` relation member 几何内联在 `members[].geometry`，读顶层 way 元素=漏抓（玄武湖判例）。
- **城市通透度**：「拉远雾蒙蒙」根因=城市卫星底图本身灰，不是 haze（hz 归零实测变化甚微）——通透来自 raster sat/con + cf 滤镜三连，城市预设 hz=0。
- **楼宇真实感**：色域收窄到屋顶暖米灰四档（`buildingStyle.color0-3`）+opacity .72 微透卫星屋顶+heightX .8 压 OSM 高估楼高（「均质灰盒子=假」判词）。**地标识别**：Feature `properties.lm`+真实 h → landmarkColor 亮金+landmarkHeightX；名牌用 storyboard `marker/callout(leader:true)` 不造引擎标签。
- **金色反向补偿 goldfix（默认开）**：cfAlt 的 hue-rotate 是 canvas 全局滤镜，GL 烘焙金色（callout 标题/光圈/金点/徽章金边）被带偏 +θ 成黄绿。现烘焙/设色预先 -θ 补偿：文字/图标按 θ 三档烘备变体逐帧就近切换，circle 层 setPaintProperty 逐帧精确补偿。`goldfix=0` 回退。EP6 折多山垭口同帧对比：补偿后纯金、未补偿黄绿。
- **城市预设 `presets/urban-bright.json`**：亮调通透城市片 v2（grade+waterStyle+buildingStyle+boundaryStyle 四块并入 project.json）。编舞范式：establishing 俯冲→地标 hold→沿湖跟拍→summary 总览。
- **叙事预设 `presets/noir-gold.json`**（2026-09-16 金陵 hero 立项）：城市故事片暗调——城市压暗、地理要素与叙事金线发光。配套路线 `style.glow:true` 光晕打底（line-blur 6，alpha×0.6；暗调场景 dark edge 描边语义不适用，发光才是暗底分离）+`retain 0.95`（已走路线=已讲完的论证）+`traveler:false`（线是画出来的论证不是走出来的行程）。标准案例 `ep04-nanjing/map-jinling-hero/`（《南京城墙为什么不是方的》hero：35km 城墙轨迹 OSM 多源链拼合+史线近似补缺口）。

## 能力边界

- 输入：DEM、自然色纹理、可选 GeoJSON 路线/水系/兴趣点。
- 输出：可复算的标准地形资产、审美定帧、镜头序列和 4K 视频。
- 当前视觉母版：`verdant-cinematic`，目标是青山、湿润空气、暖晨光、远山泛蓝与克制路线光带。
- 数据与渲染解耦。引擎不下载整幅全国数据，只裁剪当前 `bounds` 所需窗口。
- Blender、GDAL 都是可选后端：`doctor` 只检测，不擅自安装；缺 GDAL 时 PNG/Terrarium 输入仍可工作。
- Python 基础依赖只有 Pillow 与 NumPy，见 `requirements.txt`。

## PBR 材质库

`verdant-cinematic` 支持可选的岩石 PBR 三件套（diffuse / OpenGL normal / roughness）。素材文件放在 preset 声明的位置，属于本机缓存，不进入 git；缺失时后端自动回退到程序化材质。当前审美夹具使用 Poly Haven 的 `aerial_rocks_04`（CC0），仅下载 2K 贴图，不捆绑无关材质库。

PBR 负责岩壁微观质感，DEM 仍负责真实地形，卫星影像只以低权重提供森林和沟谷的地理变化。三者不得互相替代。

## v1：Blender 自然地形定帧

```bash
python3 packages/map_studio/mapstudio.py init /tmp/huangshan-map
python3 packages/map_studio/mapstudio.py validate /tmp/huangshan-map/scene.json
python3 packages/map_studio/mapstudio.py doctor
python3 packages/map_studio/mapstudio.py prepare /tmp/huangshan-map/scene.json
python3 packages/map_studio/mapstudio.py render /tmp/huangshan-map/scene.json --still hero
```

所有相对路径都相对 `scene.json` 解析，因而能力包可以被任意项目调用。

## v1 场景契约

```json
{
  "schemaVersion": 1,
  "name": "huangshan",
  "bounds": [118.135, 30.095, 118.205, 30.160],
  "sources": {
    "dem": {"path": "data/dem.png", "format": "terrarium", "geoSidecar": "data/dem.geo.json"},
    "texture": {"path": "data/texture.jpg", "geoSidecar": "data/texture.geo.json"},
    "routes": "data/routes.geojson"
  },
  "look": {"preset": "verdant-cinematic"},
  "shots": [{"id": "hero", "kind": "still", "cameraPreset": "ridge-reveal"}],
  "output": {"directory": "output", "width": 1920, "height": 1080, "terrainGridMax": 1536}
}
```

`terrainGridMax` 控制裁窗后的最长边网格分辨率：快速技术预览可用 512，Hero 定帧默认建议 1536，最终近景可按源 DEM 质量提高到 2048；提高它不会生成不存在的地形细节。

完整约束见 `schemas/scene.schema.json`。源影像不进入能力包；示例只提供 spec。

## 分层

1. `validate`：拒绝缺边界、未知格式、越界路线与项目私有路径假设。
2. `prepare`：按 bounds 裁剪并输出 `height.npy`、`texture.jpg` 和 manifest；不访问网络。
3. `look`：预处理阶段生成对齐的坡度、岩壁、森林与谷地 mask；材质、植被、云海分别消费这些 mask，不改地理事实。
4. `route`：路线贴地、独立显隐和生长动画。
5. `shot`：镜头只读预设和关键帧，不在代码里写某个景区名称。
6. `render`：预览与终版使用同一场景，只有采样率和分辨率不同。

## 审美闸门

先验三张定帧，再做动画：

1. 无路线的自然 Hero；
2. 全貌空间定帧；
3. 路线开启后的攻略定帧。

自然 Hero 单独不成立时，禁止用路线、字幕或运镜掩盖。

## 外部工具与网络

`doctor` 会报告 `blender`、`gdal_translate`、`oiiotool`、`ffmpeg`。只有执行对应后端时才要求安装。

- Blender：正式渲染器，必需。
- GDAL/PROJ：GeoTIFF、重投影和像元对齐时必需；使用隔离环境，避免污染系统 Python。
- OpenImageIO：仅在 EXR/专业纹理批处理时需要，当前 PNG/JPEG 链路不安装。

最小 GDAL 环境定义在 `environment-gdal.yml`，不包含数据库、Arrow、AWS SDK 或地图数据。

访问国外数据源时显式设置：

```bash
# 海外数据源（AWS S3 Terrarium / Esri 视地区）需自备代理：
export https_proxy=http://<your-proxy>:<port>
export http_proxy=http://<your-proxy>:<port>
```

能力包不会在运行中静默下载大数据或安装软件。
