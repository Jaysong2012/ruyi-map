# EVOLUTION — 工程化演进机制

ruyi-map 不是一次性代码导出，而是一套可持续演进的工程。本文件定义它的演进规则。

## 一、Spec 版本化

- 所有输入 spec 必须带 `schemaVersion`（新 spec 从 1 起）。
- 每条管线的 spec 有 JSON Schema 正本（`packages/map_studio/schemas/` 五份是范式；
  其余管线补齐是既定 roadmap）。
- Schema 变更 = CHANGELOG minor；渲染输出语义变更 = major 并在 CHANGELOG 写明迁移指南。
- CI/闸门校验 examples 下全部 spec 过 schema（`tests/gates/`）。

## 二、判例 → 硬闸注册表

创作/工程判例**入库不算沉淀，变成可执行检查才算**。机制：

1. 判例写进对应手册（`docs/craft/*.md` 或包 README），每条尽量附 gate 脚本路径。
2. 可自动判断的规则必须在 `tests/gates/` 有对应脚本：
   - `gate_no_private_residue.py`：私货/系统字体/内网地址残留扫描
   - `gate_scene_specs.py`：terrain_block 参数纪律（base 必填/夸张比/路线五件套）
   - `gate_mapstudio_fixtures.py`：夹具 schema 契约 + build 确定性
3. `ruyi-map check` 一键全量执行；新判例入册时自问「能否写成 gate」。

## 三、确定性渲染契约

- 所有渲染器的时间语义是纯函数：`__setT(t)`/`__render(t)` 相同 t 必然同帧。
- examples 的黄金基线（`compiled.json`/`render_report*.json`）入库，回归靠数值 diff。
- GPU 重任务串行；改 spec 必清产物缓存；瓦片/DEM 变更必须重编译并抽查 ground 字段。

## 四、Preset 注册机制

- `packages/map_studio/presets/` 目录即注册表：green-lush-mountains（自然攻略默认）/
  urban-bright（亮调城市）/ noir-gold（暗调叙事）/ verdant-cinematic（Blender still）。
- project.json 按名引用；新增 preset = 加一个 JSON 文件，零代码改动。

## 五、扩展标准动作（CONTRIBUTING 摘要）

- **新增 scene program**：builder 函数 → BUILDERS 注册表登记 → PROGRAMS.md 参数表 →
  examples 加一个最小 spec → 过 `gate_scene_specs`。
- **新增管线**：packages/<name>/ + 包 README（形态/命令/spec/判例/契约五段式）+
  CAPABILITY_MATRIX 选择器登记 + CLI 路由 + examples 可跑案例。
- **新增 QA gate**：tests/gates/gate_<规则>.py，退出码 0/1 语义，输出 FAIL 明细。

## 六、版本与发布

- 语义化版本（pyproject.toml + CHANGELOG.md）。
- 发布前检查：`ruyi-map doctor` 全绿、`ruyi-map check` 全过、examples 冒烟（见 README 验证矩阵）。
