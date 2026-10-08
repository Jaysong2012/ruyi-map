# guide_map — 卫星洗纸时刻表攻略地图管线

「总览时刻表地图 + 区域推进 beat + 决策动效 fx」一条管线，spec JSON 驱动，产出可直接进剪辑合成的地图视频。已在多部已发布旅游攻略作品中验证。

## 形态

- **总览**：左 mapW 洗纸卫星地图 + 右侧常驻「动线时刻表」面板（站点编号徽标 ↔ 地图编号点一一对应）；站点三态（current 金 / done 满亮 / todo 灰影）；岔口国家公园式放大窗（声明不同比例）
- **beat**：区域取景 + 路线三态（走过灰绿 / 当前金 / 未走计划线）+ **行进徽章 icon**（圆徽章图钉=深圆底+金描边+白 glyph+下引线点，leg kind bus/ped 驱动；小光点判死，判例 20）+ 面板行态同步
- **reveal**：金线沿真实路网描路（含返程，交通异色：车金实线 / 步行金壳白芯虚线）→ 站点级联点亮
- **fx 决策动效**（`fx_decision.py`）：判决用地图动作表达——`cross` 不连通虚线生长→闪→红叉 stamp→留证；`gray` 劝退=路线+徽标+站名灰化收拢；`half` 条件出口=灰→半亮放行；保持段治死帧用**连续推近**（单条长视频 zoom z0→z1，多段切片引用无缝续接，判例 21）
- **s6card**：全量时刻表收藏帧，缓推只推地图区、面板锁定

## 一条命令

```bash
# 0) 备料：瓦片缓存（fetch_sat_tiles.py）+ locations.json + （可选）手描水面
python3 packages/guide_map/fetch_sat_tiles.py <spec.json>

# 粗剪（720p states+视频）：
python3 packages/guide_map/run_pipeline.py <spec.json> <workdir> <outdir>
# 终版（4K states4k+视频）：
python3 packages/guide_map/run_pipeline.py <spec.json> <workdir> <outdir> --final --qa
# 只重渲单产物 / 强制全跑 / 干跑看计划：
  --jobs=s6card   --force   --check
```

六阶段：base→overview→beats→states(→states4k)→anim→**fx**（spec.fx 存在才跑）。
新鲜度跳步：base/overview/beats 秒级每次全跑；states/anim 只在 spec 比产物新时重跑；**fx 在 spec 或 states 比 fx 产物新时重跑**（--force 覆盖）。前置缺料直接报错退出，不产半成品。
依赖：node + playwright-core（仓根 `npm install && npm run setup`）、ffmpeg、Pillow+numpy。

## 调试：逐阶段手动跑

```bash
python3 packages/guide_map/build_base.py     <spec.json> <workdir>   # 瓦片拼接→洗纸→水面→路线→sat_frame/sat_inset/sat_meta
python3 packages/guide_map/build_overview.py <spec.json> <workdir>   # 总览 SVG 标注+面板 → final_sat.html
python3 packages/guide_map/build_beats.py    <spec.json> <workdir>   # 区域 beat 底图 PNG + 标注 HTML + beat_meta
python3 packages/guide_map/render_states.py  <spec.json> <workdir> [--4k]  # 状态截图 states/ states4k/
ANIM_S2=1.0 python3 packages/guide_map/render_anim.py <spec.json> <workdir> <outdir>   # 720p 视频（1.5=4K）
FX_S2=1.0    python3 packages/guide_map/fx_decision.py <spec.json> <workdir> <outdir> [cross,gray,half]
python3 packages/render_core/python/frame_qa.py <成片.mp4>            # 黑带均匀度扫描（硬闸）
```

## spec 关键字段

`bbox`(与马赛克一致)/`locationsFile`/`locOverrides`/`specialPoints`/`routes.bus|walk|tailMuted`/**`routes.rawGeo`|外部文件 `routes.rawGeoFile`**(真实路网坐标链 `{core,w,dash?,alpha?}`，与站点链同 namespace，判例 22)/`waters.file|colors`（可选层）/`wash`(洗纸配方)/`frame.mapW|canvasW|canvasH|margin`/**`frame.rotate90`**(可 false=不旋转)/`inset.bbox|scale|at|chrome`/`overview.title|valleyNames|mainStops(支持 badgeOnly)|dots|insetStops(key 带 in_ 前缀)|notes|legend|panel.rows|s6Banner.at`/`beats.<name>.bbox|rot|tl|bias|cur|done|leg|doneStops|todoStops`/`dayPath[]`(真实一日动线含返程)/`anim.reveal|beatDur|s6card`/**`fx.cross{a,b,dur}|fx.gray{route,stop,stopN?,stopName?,labelAt?,dur,zoom?}|fx.half{...,dur,zoom?}`**。

参照实例：`examples/guide-map-yading/`（基础形态，瓦片随仓离线可跑）、`examples/guide-map-altay/`（rawGeo 四色放射+inset+fx 全要素）。

## 判例（全部踩过，勿再犯）

1. 马赛克宽度必须够 ROTATE_90 后取景高
2. **ROTATE_90 坐标映射 (y, w-1-x) 的 w 用旋转前宽度**（transpose 后读 size=交换尺寸）
3. **states4k zoom 无效化**：截图 CSS zoom 不生效 → 5760 画布内容贴左上；render_anim/fx 的 load_state 裁左上内容区，下游勿直接当满幅
4. 黑带检测：x264 黑电平 16-32，<8 亮度阈值失效 → **std 均匀度扫描**（frame_qa.py）
5. 描路必须沿真实路网含返程（假线判死）；交通方式异色
6. 高倍放大用 sat_clean 净底+矢量重画水面（恒定 3px 白边）与路线（烘焙线宽随缩放失控=贴纸感）
7. inset-chrome 与 coverbox 必须与 inset 同显隐（联动）
8. s6card 缓推只推地图区、面板锁定（整帧缩放必裁面板文字）
9. beat 目标偏置取景 clamp；湖身延伸方向不能朝面板
10. 放大窗内枢纽站太挤时只留徽标无文字（编号回查面板）
11. **面板行标题超宽换行压行**（长时段前缀 42px 超可用宽≈panel宽-150）→ `panel.fontScale` 缩到单行放下 + l1 nowrap
12. **总览主图标签=短站名+极短 desc**，长 desc/长时间前缀全部回面板（站点密集区必堆叠）
13. **亮背景（雪山/灰岩）线稿必须深壳垫底**：白壳/金白虚线/灰绿走过线在全图尺度隐身（走过芯 (85,90,80)、虚线 dash_px 18）
14. **面板 done 态≠调暗**：s6 收藏态全行=done，done 若 0.60 透明+空心徽标=整卡洗灰；done=满亮+天数色填充徽标，调暗只留 todo
15. **端口「能通就复用」=并发跨项目串台**：根治=哨兵文件校验 serve 目录+端口扫描+用完自关；多项目并发渲染前确认无僵尸 http.server
16. **主图徽标 n 与面板 rn 必须同一套行程编号+同色**：编号是行程步序不是地理顺序——设计期 mainStops/insetStops 的 n/color 必须与 panel.rows 逐行双向核对；改 panel 行序必同步改徽标
17. **绘制顺序=主线先画支线后画**：rawGeo 按名字序迭代时 main 宽壳金线会把同走廊支线整条盖没——build_beats 已排序 main 先；**新加路线必须想「谁和谁同走廊、谁盖谁」**
18. **取景/bbox 变更必须 build_beats→render_states→render_anim 全链**：漏 render_states=新 beat_meta×旧底图状态帧错位；fx 以 states/v7_full 为底，states 重跑后 **fx 必须重渲**
19. **fx dur 必须 ≥ 排轴窗长**：fx 视频被多段切片引用，实际引用跨度可能超单段 dur——fx dur 按全引用链总长+1s 冗余给
20. **行进图标=圆徽章图钉，小光点判死**：深圆底+金描边+白 glyph（bus/ped 矢量）+下引线点钉路线点
21. **灰化/保持类长镜头连续推近法**：保持段静止=死帧——渲单条长视频 zoom z0→z1，多段切片按源时连续引用无缝续接；跨切出再切回同 zoom 位=有意连续
22. **rawGeo 坐标链与站点链同 namespace**：resolve 三形态——dict 取 coordinates / 坐标链直接投影（点密不 chaikin）/ 站点 id 链走 seg_pts；`dash:true` 走金壳白芯虚线
23. **水面兜底可用卫星图阈值分割**（手描不可得时）：绿松石水体 `(g>b)&(b>r)&(g>100)&((g-r)>35)&((b-r)>22)&((g-b)<60)`；手描仍是正解，分割产出必须人工修边
24. **同 n 多站/主图与 inset 同 n 时**：SVG 显隐用 querySelectorAll 属性选择器（getElementById 只控第一个）；state_spec 主站与 inset 站显隐并列 if 互不短路；inset 大图截图前等 img.complete

## 设计契约（怎样算好）

**编号与颜色（第一优先级）**
- 徽标编号=行程步序，主图徽标 n / inset 徽标 n / 面板行 rn 三者同号同色；颜色语义示例：Day1=gold、Day2=teal、死线=orange、返程/中性=gray；或按线色=金主线/绿支线/青支线/红劝退+图例 legend
- 面板行=[编号, 时刻, 站名, 极短 desc, 色]；时刻前缀超 42px 单行宽→`panel.fontScale` 缩（判例 11）
- **同走廊线分色必须落图例**：主线金/支线异色放射，绘制顺序主线先支线后（判例 17），分支线在总览必须肉眼可分

**文字层级**
- 主图标签=短站名+极短 desc（≤8 字），长信息全部回面板行（判例 12）；枢纽互压区只留徽标（判例 10）
- 面板=黑底白字清清楚楚：done=满亮+天数色填充徽标（判例 14），todo 才调暗 0.28；tg 0.92/sub 0.85/leg 0.95

**底图与线稿**
- 洗纸配方 spec.wash（模糊+降饱和+局部对比压缩）；亮背景（雪山/灰岩）所有线稿深壳垫底（判例 13）
- 描路=真实路网含返程，车金实线/步行金壳白芯虚线（判例 5）；rawGeo 坐标链正解（判例 22）；高倍放大矢量重画水面路线（判例 6）

**地图×文字共存（下游合成层对接建议）**
- **地图出现时旁白字幕退场**：合成器应对地图镜头生成字幕抑制窗
- **信息层（chip）裸字无框+左侧中下放**：磨砂背板判死，重描边+软阴影保底可读；x=48、y 三档 0.48/0.60/0.72 防叠（行距 ≥0.12H）
- **收藏 CTA/截图横幅置底**（s6Banner.at 底部），不压核心内容
- inset 微调法：放大窗先调 scale/at（放大+右移填空），标注重叠改 labelAt anchor 避让，不用遮罩补丁

**收藏卡（s6card=交付的产品）**
- 全量时刻表+「截图存好·照着走」横幅+时效脚注（核验日期+以官方公告为准）
- 缓推只推地图区、面板锁定（判例 8）；导出=states4k s6 态直裁左上 3840×2160（HTML 直截无编码损耗，勿用视频抽帧）

## 新项目对接

1. 备 locations.json（景点 lnglat）+（可选）手描水面 json（水面不可信时用判例 23 卫星图阈值分割兜底，产出必须人工修边）
2. `fetch_sat_tiles.py <spec.json>` 抓 z14 瓦片到 `<proj>/map/data/sat/14/`
3. 复制 `examples/guide-map-yading/guide_map_spec.json` 改地名/坐标/时刻表/beats（要 rawGeo 四色放射+fx 决策动效抄 `examples/guide-map-altay/`）
4. 产物进剪辑时间轴（trim=[起点,时长] 语义；fx 多段切片引用注意判例 19/21）
