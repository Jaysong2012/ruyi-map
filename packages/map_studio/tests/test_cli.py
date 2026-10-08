import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


class CliTest(unittest.TestCase):
    def test_init_and_validate(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "scene"
            subprocess.run([sys.executable, str(ROOT / "mapstudio.py"), "init", str(target)], check=True)
            doc = json.loads((target / "scene.json").read_text())
            self.assertEqual(doc["schemaVersion"], 1)
            result = subprocess.run([sys.executable, str(ROOT / "mapstudio.py"), "validate", str(target / "scene.json")], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0)
            self.assertIn("OK schema", result.stdout)

    def test_prepare_crops_only_requested_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "scene"
            subprocess.run([sys.executable, str(ROOT / "mapstudio.py"), "init", str(target)], check=True)
            doc = json.loads((target / "scene.json").read_text())
            doc["bounds"] = [1, 1, 3, 3]
            data = target / "data"
            Image.new("RGB", (8, 8), (128, 4, 0)).save(data / "dem.png")
            Image.new("RGB", (8, 8), (20, 90, 30)).save(data / "texture.jpg")
            sidecar = {"bounds": [0, 0, 4, 4]}
            (data / "dem.geo.json").write_text(json.dumps(sidecar))
            (data / "texture.geo.json").write_text(json.dumps(sidecar))
            (data / "routes.geojson").write_text('{"type":"FeatureCollection","features":[]}')
            (target / "scene.json").write_text(json.dumps(doc))
            subprocess.run([sys.executable, str(ROOT / "mapstudio.py"), "prepare", str(target / "scene.json")], check=True)
            manifest = json.loads((target / "output/prepared/manifest.json").read_text())
            self.assertEqual(manifest["grid"], {"rows": 4, "cols": 4, "minimumMeters": 4.0, "maximumMeters": 4.0})
            self.assertEqual(set(manifest["masks"]), {"slope", "rock", "forest", "valley", "hillshade"})
            for filename in manifest["masks"].values():
                with Image.open(target / "output/prepared" / filename) as mask:
                    self.assertEqual(mask.size, (4, 4))

    def test_route_init_build_and_qa_are_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "route"
            subprocess.run([sys.executable, str(ROOT / "mapstudio.py"), "init-route", str(target)], check=True)
            command = [sys.executable, str(ROOT / "mapstudio.py"), "build", str(target / "project.json")]
            subprocess.run(command, check=True)
            first = json.loads((target / "output/compiled.json").read_text())
            subprocess.run(command, check=True)
            second = json.loads((target / "output/compiled.json").read_text())
            self.assertEqual(first, second)
            template = json.loads((ROOT / "examples/wulingyuan-follow-route/routes.json").read_text())
            expect = template["segments"][0].get("style", {}).get("label")
            self.assertEqual(first["segments"][0]["style"]["label"], expect)
            result = subprocess.run(
                [sys.executable, str(ROOT / "mapstudio.py"), "qa", str(target / "project.json")],
                text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_route_build_rejects_unknown_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "route"
            subprocess.run([sys.executable, str(ROOT / "mapstudio.py"), "init-route", str(target)], check=True)
            routes_path = target / "routes.json"
            routes = json.loads(routes_path.read_text())
            segment = next(s for s in routes["segments"] if "locations" in s)
            segment.pop("coordinates", None)  # 自带坐标会绕过 locations 解析
            segment["locations"][1] = "missing"
            routes_path.write_text(json.dumps(routes))
            result = subprocess.run(
                [sys.executable, str(ROOT / "mapstudio.py"), "build", str(target / "project.json")],
                text=True, capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unknown locations", result.stderr)

    def test_route_build_rejects_overlapping_route_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "route"
            subprocess.run([sys.executable, str(ROOT / "mapstudio.py"), "init-route", str(target)], check=True)
            story_path = target / "storyboard.json"
            story = json.loads(story_path.read_text())
            route_events = [e for e in story["events"] if e["type"] == "route"]
            if len(route_events) < 2:  # 模板只有一个 route 事件时克隆一个相邻段（原位插入保持 start 有序）
                import copy
                idx = story["events"].index(route_events[0])
                clone = copy.deepcopy(route_events[0])
                clone["start"] = route_events[0]["end"] + 0.1
                clone["end"] = clone["start"] + 2
                story["events"].insert(idx + 1, clone)
                route_events = [e for e in story["events"] if e["type"] == "route"]
            route_events[1]["start"] = route_events[0]["end"] - 0.1
            story_path.write_text(json.dumps(story))
            result = subprocess.run(
                [sys.executable, str(ROOT / "mapstudio.py"), "build", str(target / "project.json")],
                text=True, capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("route events overlap", result.stderr)
    def test_renderer_has_no_scene_hardcode(self):
        """通用渲染器不得包含任何景区名称、坐标或场景分支（交接 P0 迁移原则）。"""
        web = ROOT / "mapstudio/web"
        forbidden = ["黄山", "光明顶", "始信峰", "迎客松", "云谷寺", "慈光阁", "西海", "九寨沟", "五花海",
                     "武陵源", "百龙", "huangshan", "jiuzhaigou", "wulingyuan",
                     "118.15", "118.16", "118.17", "118.18", "30.12", "30.13",
                     "103.9", "33.2", "33.3", "110.4", "29.3"]

        def code_only(text):
            import re
            text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)   # 块注释
            text = re.sub(r"<!--.*?-->", "", text, flags=re.S)     # HTML 注释
            return "\n".join(line.split("//")[0] for line in text.splitlines())  # 行注释

        for asset in ["route_renderer.html", "render.mjs"]:
            text = code_only((web / asset).read_text(encoding="utf-8"))
            for token in forbidden:
                self.assertNotIn(token, text, f"{asset} contains scene token: {token}")

    def test_second_fixture_builds_and_qa_pass(self):
        """第二个非黄山夹具：只改三份 JSON 即可编译通过（无隐藏硬编码的数据侧证明）。"""
        project = ROOT / "examples/jiuzhaigou-route/project.json"
        command = [sys.executable, str(ROOT / "mapstudio.py"), "build", str(project)]
        subprocess.run(command, check=True)
        compiled = json.loads((project.parent / "output/compiled.json").read_text())
        self.assertEqual(compiled["name"], "jiuzhaigou-route-proof")
        self.assertEqual(len(compiled["segments"]), 5)
        result = subprocess.run(
            [sys.executable, str(ROOT / "mapstudio.py"), "qa", str(project)],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
