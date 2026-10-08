# 标准案例：武陵源跟拍路线（wulingyuan-follow-route）

张家界武陵源 D2 山上日首段——**主人终审通过的跟拍模式标准案例**（2026-09-10，小样 v8）。
17 秒包含全部事件类型：开场建立镜头 → 跟拍生长（环保车 13.3km 盘山）→ 途中景点 tag+走过点亮 →
到达拍（hold 推近+光圈+解读卡）。

> 制作指导（从剧本到成片全流程 SOP）：`../../FOLLOW_ROUTE_GUIDE.md`
> 工程判例（单管线铁律/净空射线/闪烁军规）：包根 README「跟拍模式与单管线铁律」节

## 文件

| 文件 | 内容 |
|---|---|
| `locations.json` | 标志门/百龙天梯两点（OSM 实锤坐标） |
| `routes.json` | bus-elevator 段 13.3km 真实盘山轨迹（OSM Dijkstra+卫星图目检修正） |
| `storyboard.json` | 17s 编舞：camera/route(follow 配方)/marker/hold(到达拍配方)/callout |
| `project.json` | bounds/瓦片源/TEX 1.5/输出规格 |
| `data/` | 瓦片（**不入 git**——`fetch-tiles` 重建，或从同 bounds 项目复制） |
| `output/` | 产物（不入 git） |

## 快速复现

```bash
cd packages/map-studio/examples/wulingyuan-follow-route

# 0. 首次：抓瓦片（海外源走代理；或从同 bounds 项目直接复制 data/）
python3 ../../mapstudio.py fetch-tiles project.json

# 1. 编译
python3 -c "import sys;sys.path.insert(0,'../../mapstudio')
from pathlib import Path;import compiler;compiler.compile_project(Path('project.json'))"

# 2. 渲染（720p 小样，510 帧约 5 分钟）
python3 ../../mapstudio/serve.py . 8932 &
node ../../mapstudio/web/render.mjs --url http://127.0.0.1:8932 \
  --out /tmp/example-frames --duration 17 --fps 30 --q "legend=0" --report /tmp/example-frames/report.json

# 3. 合成
ffmpeg -framerate 30 -i /tmp/example-frames/f%04d.png -c:v libx264 -crf 20 -pix_fmt yuv420p out.mp4
```

## QA 三连（送审前必做）

```bash
# ① report 检查
python3 -c "import json;r=json.load(open('/tmp/example-frames/report.json'));\
print('frames:',r['frames'],'errors:',r['errors'][:100] or 'none','idleTO:',len(r['idleTimeouts']))"

# ② 车头徽章逐帧存在性（行进窗 f45-f405 应 0 缺失）
python3 - <<'EOF'
from PIL import Image
import numpy as np
from scipy import ndimage
missing=[]
for i in range(45,406):
    im=np.array(Image.open(f'/tmp/example-frames/f{i:04d}.png').convert('RGB'))
    gold=(abs(im[:,:,0].astype(int)-255)<50)&(abs(im[:,:,1].astype(int)-207)<50)&(abs(im[:,:,2].astype(int)-101)<70)
    lab,n=ndimage.label(gold)
    if max([int((lab==k).sum()) for k in range(1,n+1)]+[0])<8: missing.append(i)
print('badge missing:',missing or 'none')
EOF

# ③ 帧差平滑（尖峰=换档/闪帧；本案例 17s 全程应 <10）
python3 - <<'EOF'
from PIL import Image
import numpy as np
prev=None;mx=(0,0)
for i in range(1,510):
    im=np.array(Image.open(f'/tmp/example-frames/f{i:04d}.png').convert('RGB').resize((320,180)),dtype=np.int16)
    if prev is not None:
        d=float(np.abs(im-prev).mean())
        if d>mx[0]: mx=(d,i)
    prev=im
print('max diff %.2f at f%d'%(mx[0],mx[1]))
EOF
```

## 改造要点（换成你的目的地）

1. 三份 JSON 换掉（坐标实锤/轨迹真实+段末目检/事件按 start 升序）；
2. project.json 改 bounds/center，`fetch-tiles` 重抓；
3. hold 的 `bearing` 必须按你的跟拍末端切向重算（别抄 -60），`agl` 保 zoom<14；
4. 节奏按 §FOLLOW_ROUTE_GUIDE 四节对位旁白句界。

## 本案例已验证的数值（复查基线）

- 510 帧 0 errors / 0 idleTimeouts；帧差 max 6.38（hold 段）；
- 车头徽章行进窗 360/360 帧在线；t≈7-8s 车线同隐 ~1s（翻山肩诚实遮挡，设计行为）；
- hold 过渡摆头 ≤19°/s，zoom 峰值 13.87（不跨 z14）。
