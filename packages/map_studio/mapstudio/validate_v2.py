"""validate_v2.py — v2 路线工程（project/locations/routes/storyboard）按 schemas/*.json 真校验。

审计发现（2026-09-12）：五份 JSON Schema 此前无任何代码消费；真正的校验只有 compiler 手写检查，
storyboard 里 camera/hold/marker 子字段、hud/blendSec/alsoShow/lockCamera/grade 全不校验，
locations.kind 枚举与渲染器实现（entry/exit）脱节。本模块把 schema 接进 `mapstudio.py validate-route`。
"""
from __future__ import annotations

import json
from pathlib import Path

SCHEMAS = Path(__file__).resolve().parents[1] / "schemas"


def _load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def validate_route_project(project_path: Path) -> list[str]:
    """返回问题列表（空=通过）。需要 jsonschema；缺依赖时给一条明确提示而不是假通过。"""
    try:
        import jsonschema
    except ImportError:
        return ["jsonschema 未安装（pip install jsonschema）——schema 校验无法进行，不冒充通过"]
    project_path = project_path.resolve()
    base = project_path.parent
    problems: list[str] = []
    docs = {"project": (project_path, "project-v2.schema.json")}
    try:
        project = _load(project_path)
    except json.JSONDecodeError as e:
        return [f"project.json 不可解析: {e}"]
    for name, schema_file in (("locations", "locations-v2.schema.json"), ("routes", "routes-v2.schema.json"),
                              ("storyboard", "storyboard-v2.schema.json")):
        rel = (project.get("inputs") or {}).get(name)
        if not rel:
            problems.append(f"inputs.{name} 缺失")
            continue
        docs[name] = (base / rel, schema_file)
    for name, (path, schema_file) in docs.items():
        if not path.is_file():
            problems.append(f"{name}: 文件不存在 {path}")
            continue
        try:
            doc = _load(path)
        except json.JSONDecodeError as e:
            problems.append(f"{name}: 不可解析 {e}")
            continue
        schema = _load(SCHEMAS / schema_file)
        validator = jsonschema.Draft202012Validator(schema)
        for err in sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path)):
            loc = "/".join(str(x) for x in err.absolute_path) or "<root>"
            problems.append(f"{name}:{loc}: {err.message}")
    return problems
