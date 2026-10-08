# scene3d-sampler — 3D 程序场景示例（D 管线）

「机制/尺度/关系」的诚实代码图解：Three.js builder 模板 + spec JSON → 确定性逐帧渲染。
三个代表 program，全部离线可跑（纹理走仓内 `assets/space/textures/`）：

```bash
node packages/scene3d/render_scene.mjs examples/scene3d-sampler/lights_out.json        # 地球熄灯→夜景灯光 17s
node packages/scene3d/render_scene.mjs examples/scene3d-sampler/solar_system_map.json  # 太阳系轨道图 8s（入门最短，先试这个）
node packages/scene3d/render_scene.mjs examples/scene3d-sampler/arctic_wall.json       # 北极冷空气围墙 25s
```

**判死线（立项纪律）**：水/流体/侵蚀/泥沙/火/烟是观众日常经验内的动态物理过程，
程序渲染真实感不达标——这类题材没有真实素材锚就不要用本管线立项。

全部 17 个 program 的索引与 spec 字段见 `packages/scene3d/PROGRAMS.md`。
