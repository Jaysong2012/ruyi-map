#!/usr/bin/env python3
"""Map Studio v2 本地渲染服务：项目数据 + 包内渲染器，瓦片缺失落日志。

路由：
  /renderer.html        包内通用渲染器
  /lib/*                包内 maplibre 资源
  /compiled.json        项目 output/compiled.json
  其余                  项目目录静态文件（data/sat、data/dem 等瓦片路径）

瓦片类请求（.jpg/.png 且路径含 /sat/ 或 /dem/）的非 200 响应追加写入
项目 output/tile_missing.log，供 qa-render 判缺瓦片。
"""
from __future__ import annotations

import http.server
import re
import sys
import threading
from pathlib import Path

WEB = Path(__file__).resolve().parent / "web"
FONTS = Path(__file__).resolve().parents[3] / "assets" / "fonts"   # packages/map_studio/mapstudio/ → 仓根
TILE_PATH_RE = re.compile(r"^(.*)/(\d+)/(\d+)/(\d+)\.(jpg|png)$")


def _nearest_tile(path: str) -> str | None:
    """窗口边缘缺瓦片兜底：返回 ±3 环内最近存在瓦片（边缘复制，远景无感，比黑角好）。"""
    m = TILE_PATH_RE.match(path)
    if not m:
        return None
    base, z, x, y, ext = m.group(1), m.group(2), int(m.group(3)), int(m.group(4)), m.group(5)
    for r in range(1, 4):
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if max(abs(dx), abs(dy)) != r:
                    continue
                cand = f"{base}/{z}/{x + dx}/{y + dy}.{ext}"
                if Path(cand).is_file():
                    return cand
    return None


def make_handler(project_dir: Path):
    missing_log = project_dir / "output" / "tile_missing.log"

    class Handler(http.server.SimpleHTTPRequestHandler):
        def translate_path(self, path):
            p = path.split("?")[0].lstrip("/")
            if p == "renderer.html" or p == "":
                return str(WEB / "route_renderer.html")
            if p.startswith("lib/"):
                return str(WEB / p)
            if p.startswith("fonts/"):
                return str(FONTS / p[len("fonts/"):])
            if p == "compiled.json":
                return str(project_dir / "output" / "compiled.json")
            return str(project_dir / p)

        def send_head(self):
            path = self.translate_path(self.path)
            if ("/sat/" in path or "/dem/" in path) and not Path(path).is_file():
                alt = _nearest_tile(path)
                if alt:
                    data = Path(alt).read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg" if alt.endswith(".jpg") else "image/png")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return None
                with open(missing_log, "a", encoding="utf-8") as fh:
                    fh.write(self.path.split("?")[0] + "\n")
            return super().send_head()

        def log_message(self, fmt, *args):  # 静默，缺瓦片已单独落日志
            pass

        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    return Handler


def start_server(project_dir: Path, port: int = 0) -> tuple[http.server.ThreadingHTTPServer, int]:
    project_dir = project_dir.resolve()
    (project_dir / "output").mkdir(parents=True, exist_ok=True)
    log = project_dir / "output" / "tile_missing.log"
    if log.exists():
        log.unlink()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_handler(project_dir))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


if __name__ == "__main__":
    _, port = start_server(Path(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 8931)
    print(f"SERVING http://127.0.0.1:{port}/renderer.html", flush=True)
    threading.Event().wait()
