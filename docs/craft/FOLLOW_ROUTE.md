# FOLLOW_ROUTE — 3D 跟拍路线镜头制作手册（B 管线）

map_studio v2 跟拍模式（`camera.follow`）的配方全集。数据三件套（locations/routes/storyboard）
只改 JSON，渲染器零改动适配新目的地。

## 一、跟拍配方（终审通过版，直接抄）

```json
{"type":"route","segment":"...","start":1.5,"end":13.5,
 "camera":{"follow":true,"pitch":60,"agl":11000,"trail":0.06,"tangentWin":0.4}}
```

- `agl: 11000` + `pitch: 60` = 上帝视角跟拍档：已走路线全程留画面（8000 太低贴地 / 14000 偏地图感）。
- `trail: 0.06` = 相机拖在路线头**后方** 6% 弧长——段首起点（城市）留在画面里=「从城里出发」读感。
  前探（lookAhead）判死：段首相机在山里=「从山里出发」。
- `tangentWin: 0.4` = 摆头速率 ≤20°/s（0.12=114°/s 甩鞭判死；完全平滑=不跟弯也不对）。
  **弯密段（发夹弯类）用 1.5**：0.4 在发夹段摆动 35-85°/s 且方向反转十几次=「整体页面左右晃」；
  1.5 后方向反转清零。缓弯段保持 0.4。
- `blendSec: 0.5`（route 事件默认）在 **U 型折返衔接处必须升 2.2**：A 段末切向 vs B 段初切向差 ~180°
  时，0.5s 混合=245°/s 甩鞭；2.2s 混合=有预谋的转身。查法：逐段算末/初切向，Δ>90° 的衔接就升。
- `terrainExaggeration`（project.json）：石柱/峰林地貌 1.5（2.15 遮挡常态判死）；平缓地貌 2.0-2.15。

**到达拍配方**（hold 事件）：

```json
{"type":"hold","location":"bailong","agl":4800,"bearing":-60,"blendSec":2.2}
```

- `bearing` **必须显式给**，贴近跟拍末端切向方位（默认 baseBearing 与末端切向差几十度=甩鞭，
  是「聚焦时山体重绘感」的一半本体）。
- `agl` 让 **zoom 全程 <14**（zoom≥14 触发瓦片 z14 换档=定格时山体锐度跳变，另一半本体；
  agl 4800→zoom 13.87 安全）。推近幅度不够就用 blendSec 拉长，别拉 agl。
- `blendSec: 2.2`（默认 0.45 太短，到达拍是重场戏）。
- **高海拔景点到达拍取景补偿（引擎已内置）**：hold 的 center 会被引擎沿 bearing 前移
  `Δ=ground×TEX×tan(pitch)`——elevation 冻结语义下 look-at 平面=海拔 0，不补偿时高海拔景点
  在推近中滑出画面。正确模型=相机刚体平移（Δ=ele·tan p）。storyboard 不用管。

## 二、解读层（引擎默认行为）

- **景点 tag / 解读卡**：tag 45px / 卡标题 57px 金 / 卡正文 40px 白；**彩色**（tag 按 kind：
  entry 绿/stay 红/exit 蓝/默认金）；**打字机**（70ms/字逐字右长，全宽画布左对齐烘焙=零抖动）；
  **无背景框**（深色描边 strokeText）。位置=景点正上方（不压车不压线）。
- **右上 HUD**（路段播报）：b 42px / span 28px，保留底色框。
- 硬约束：icon-anchor 只许 `center`（非 center 在负方位角被 MapLibre 水平镜像=大字反写），
  一切定位用 icon-offset；逐字烘焙按全宽画布左对齐，禁止逐字居中（每字都抖）。

## 三、青山绿水调色预设（攻略线默认）

**旅游攻略地图=贩卖向往：亮调通透青绿。** 暗调电影感降级为特殊题材可选。
预设正本 `presets/green-lush-mountains.json`，`grade` 块原样并入 project.json 的 `map.grade`。四件套：

1. **海拔自适应调色 `cfAlt:1`**：hue/sat 随 zoom 连续插值——高空（≤11.2）hue 6°/sat 1.18 只提鲜，
   低空（≥12.8）hue 18°/sat 1.5 全强度。高空荒凉山体全局染绿=假；谷底真植被染绿=还原夏天。
2. **大气 veil `hz:.3 hzc:#e6f3ee`**：青白色远距霾，远山层次后退治沙盘感。
   **setSky 判死**（v4.7.1 mercator+terrain 下零效果），DOM veil 是唯一正解。
3. **太阳钉地球 `sunAz:300 sunAnchor:map`**：过弯坡面明暗不随相机转。
4. **hold 缓推 `creep:.025`**：单调非振荡，3 秒拉近 ~20% 让视差活着。

铁律：**hue 上限 18°**（hue-rotate 全局转色连路线一起转，25° 路线黄化贴地判死）。
副作用知情：GL 烘焙金色元素（callout 标题/光圈）偏 +18° 成黄绿。

## 四、节奏：旁白句界对位

- **先排时间轴再画地图**：旁白「几点到哪」是骨架，地图动作是投影。
- route 事件的 start/end 对齐旁白句界：旁白说「直奔 X」时车在动；说「两分钟到」时进 hold+callout。
- 行进速度观感：≈1.0~1.2km/s 视觉速已验证自然；太慢=死图，太快=晃。
  换算：段弧长 ÷ 期望秒数。
- hold 时长 ≥2.5s（光圈 2 圈+解读卡读完）；两个景点之间行进 ≥3s（节奏呼吸）。

## 五、渲染与 QA（SOP）

```bash
ruyi-map route build <项目>/project.json        # 编译（改任何 JSON 后必跑）
ruyi-map route preview <项目>/project.json --at 8.5   # 单帧看相
ruyi-map route render-route <项目>/project.json --quality rough   # 720p
ruyi-map route render-route <项目>/project.json --quality final   # 原生 4K
ruyi-map route qa-render <项目>/project.json --quality rough
```

**QA 三查（送审前必做）**：
1. **report.json**：frames 齐、errors 空、idleTimeouts=0。
2. **徽章存在性逐帧扫**：车 icon（金簇）在行进窗内 0 缺失。
3. **帧差平滑扫**：相邻帧 diff 无 >3σ 尖峰（尖峰=换档/闪帧）。
4. **联系表烙时间戳目检**：每秒一帧拼图（时间戳画进帧本体，glob 字母序≠时间序）。

**扫参走 URL**（URL>storyboard>默认）：
`--q "fagl=11000&fpitch=60&ftrail=0.06&ftw=0.4&tex=1.5&legend=0"`

## 六、判例速查

| 症状 | 根因 | 正解 |
|---|---|---|
| 发夹弯段整体页面左右晃 | tangentWin 0.4 在弯密段方向反转十几次（35-85°/s） | 弯密段 tangentWin 1.5；U 型折返衔接 blendSec 2.2 |
| 高海拔景点到达拍出屏 | hold center 钉在海拔 0 look-at 平面 | 引擎内置补偿 Δ=ele·tan(pitch)，storyboard 无需动作 |
| 大字解读层负方位角镜像 | icon-anchor 非 center，bearing 为负时 MapLibre 水平翻转 | icon-anchor 只许 center，定位全靠 icon-offset |
| 路线漂移/不在路上 | SVG overlay 手算投影 vs terrain mesh 错位 | 原生线图层（引擎 draped） |
| 车 icon 飘/悬空 | GL+SVG 双轨不一致 / symbol 层不吃地形遮挡 | 单管线+净空射线 visMul |
| 车闪（行进中） | 自研朝向判定误杀整帧清空 | circle 底座免 visMul+0.8s 交叉淡 |
| 聚焦时山体重绘 | hold bearing 甩鞭+zoom 跨瓦片整级 | 显式 bearing 贴切向+agl 保 zoom<14 |
| 景点标记飘 | DOM/Marker 异步投影 | GL symbol 引擎投影锁死 |
| 单帧预览丢 icon | 截图时 worker 未就绪 | render.mjs 慢速路径等 idle |
| 渲出来的内容不是本工程 | 旧 serve 实例占着端口 | 渲前必验内容指纹：`curl .../output/compiled.json` 对 name/segments |
| fetch-tiles 某 z 级缺失 | 该级窗口 >4000 瓦片被 skip（日志有明示） | 无 summary 且 hold agl≥4800 的工程 max zoom<14 够用；确需更高走走廊式缩窗 |
| 海报/净版图被 HUD 卡毁 | route 事件自动里程 HUD 烘焙进帧 | storyboard 该 route 事件加 `hud:false` |
| 线太粗挡地形/太细看不见 | 默认线宽一刀切 | routes 段 `style.width` 覆盖，别改渲染器常量 |
| final 4K 渲出来是平地 | 4K 走 dsf3 请求更高 z 级 DEM，缺瓦片=高程全 0 | fetch-tiles 补抓后重渲；mse 帧比对定罪；sat 更高 z 缺失父级回退可放行 |
| 长跟拍固定在同一时刻崩 | 瓦片解码内存尖峰 | render.mjs 崩溃自愈（冷启动续渲同帧）+`--resume`；report.crashes 留痕 |
| 索道/地轨段主线层消失 | `dash:true` 布尔直传 line-dasharray（须数组） | 渲染器已归一化 `true→[2.5,2]`；report.errors 有 "dasharray" 即此症 |
| 总览标签悬空不知道指哪 | 标签 offset 偏移后无视觉锚定 | marker/callout 事件加 `leader:true`（引线+端点钉烘焙进 GL 符号图） |

## 七、新目的地接入清单

1. 抄 `packages/map_studio/examples/wulingyuan-follow-route/` 三份 JSON 到新项目目录；
2. locations：OSM 实锤坐标逐点核；routes：真实轨迹+卫星图品红目检（段末必查）；
3. project.json 改 bounds/center + `fetch-tiles` 抓瓦片（海外源自备代理）；
4. storyboard 按旁白句界排事件（§四节奏表）；
5. 编译→小样→QA 三查→终审→终渲（final 4K：`render-route --quality final`）。
