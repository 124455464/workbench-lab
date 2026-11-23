#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HJF/OST 仓储可视化工作台（实验隔离版）本地服务 & 个人电脑实时回传落盘守护进程
职责：
1. 提供 http://127.0.0.1:8895 静态页面服务
2. 提供 /api/state/<mod_id> 接口，将各模块数据独立落盘至 local_only/workbench_lab/lab_data/<mod_id>.json
3. 后台每 30 秒自动轮询私有实验 Gist (e0bcb71c5149d8d7b4467022047c2367)：
   - 工作电脑在网页端修改后推上云端的数据，自动实时下载并永久保存在你这台个人电脑的硬盘里！
   - 本机网页端修改的数据，也自动通过已认证的 gh CLI 推送到同一个私有实验 Gist！
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "lab_data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

LAB_GIST_ID = "e0bcb71c5149d8d7b4467022047c2367"
PORT = 8895
POLL_INTERVAL_SEC = 30
GH_EXE = r"C:\Program Files\GitHub CLI\gh.exe"

_lock = threading.Lock()
_sync_status = {
    "gist_id": LAB_GIST_ID,
    "last_pull": "",
    "last_push": "",
    "last_error": "",
    "files_saved": [],
}


def get_gh_token() -> str:
    try:
        exe = GH_EXE if Path(GH_EXE).exists() else "gh"
        res = subprocess.run([exe, "auth", "token"], capture_output=True, text=True, timeout=8)
        if res.returncode == 0:
            return res.stdout.strip()
    except Exception:
        pass
    return os.environ.get("GITHUB_TOKEN", "").strip()


def gist_request(method: str, payload: dict | None = None) -> dict:
    token = get_gh_token()
    if not token:
        raise RuntimeError("未获取到本机 GitHub 认证 Token")
    url = f"https://api.github.com/gists/{LAB_GIST_ID}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "HJF-OST-Workbench-Lab",
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def pull_from_gist() -> list[str]:
    """将私有实验 Gist 中各模块最新 JSON 自动落盘到本机硬盘 lab_data/"""
    updated = []
    gist = gist_request("GET")
    files = gist.get("files", {})
    with _lock:
        for fname, meta in files.items():
            if not re.fullmatch(r"mod_[a-z0-9_]+\.json", fname):
                continue
            content = meta.get("content", "")
            if meta.get("truncated") and meta.get("raw_url"):
                with urllib.request.urlopen(meta["raw_url"], timeout=20) as r:
                    content = r.read().decode("utf-8")
            if not content:
                continue
            try:
                remote_obj = json.loads(content)
            except Exception:
                continue

            local_path = DATA_DIR / fname
            local_ts = 0
            if local_path.exists():
                try:
                    local_ts = json.loads(local_path.read_text(encoding="utf-8")).get("_updatedAt", 0)
                except Exception:
                    local_ts = 0

            remote_ts = remote_obj.get("_updatedAt", 0)
            if not local_path.exists() or remote_ts > local_ts:
                local_path.write_text(json.dumps(remote_obj, ensure_ascii=False, indent=2), encoding="utf-8")
                updated.append(fname)

        _sync_status["last_pull"] = time.strftime("%Y-%m-%d %H:%M:%S")
        _sync_status["last_error"] = ""
        _sync_status["files_saved"] = sorted(p.name for p in DATA_DIR.glob("mod_*.json"))
    return updated


def push_module_to_gist(mod_id: str, obj: dict) -> None:
    fname = f"{mod_id}.json"
    payload = {"files": {fname: {"content": json.dumps(obj, ensure_ascii=False)}}}
    gist_request("PATCH", payload)
    with _lock:
        _sync_status["last_push"] = time.strftime("%Y-%m-%d %H:%M:%S")
        _sync_status["last_error"] = ""


def background_mirror_loop() -> None:
    while True:
        try:
            pull_from_gist()
        except Exception as e:
            with _lock:
                _sync_status["last_error"] = str(e)
        time.sleep(POLL_INTERVAL_SEC)


class LabHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def log_message(self, format, *args):
        pass  # 静默常规日志

    def _send_json(self, code: int, data: dict):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/sync/status":
            with _lock:
                self._send_json(200, dict(_sync_status))
            return

        m = re.fullmatch(r"/api/state/(mod_[a-z0-9_]+)", self.path.split("?")[0])
        if m:
            mod_id = m.group(1)
            fpath = DATA_DIR / f"{mod_id}.json"
            if fpath.exists():
                try:
                    obj = json.loads(fpath.read_text(encoding="utf-8"))
                    self._send_json(200, {"ok": True, "data": obj})
                except Exception as e:
                    self._send_json(500, {"ok": False, "error": str(e)})
            else:
                self._send_json(200, {"ok": True, "data": None})
            return

        super().do_GET()

    def do_POST(self):
        if self.path == "/api/sync/pull":
            try:
                updated = pull_from_gist()
                self._send_json(200, {"ok": True, "updated": updated})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        m = re.fullmatch(r"/api/state/(mod_[a-z0-9_]+)", self.path.split("?")[0])
        if m:
            mod_id = m.group(1)
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            try:
                obj = json.loads(body.decode("utf-8"))
                obj["_updatedAt"] = int(time.time() * 1000)
                with _lock:
                    (DATA_DIR / f"{mod_id}.json").write_text(
                        json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8"
                    )
                    _sync_status["files_saved"] = sorted(p.name for p in DATA_DIR.glob("mod_*.json"))
                # 异步推送至私有实验 Gist，不阻塞页面响应
                threading.Thread(target=self._safe_push, args=(mod_id, obj), daemon=True).start()
                self._send_json(200, {"ok": True, "_updatedAt": obj["_updatedAt"]})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        self._send_json(404, {"ok": False, "error": "Not Found"})

    @staticmethod
    def _safe_push(mod_id: str, obj: dict):
        try:
            push_module_to_gist(mod_id, obj)
        except Exception as e:
            with _lock:
                _sync_status["last_error"] = f"push {mod_id}: {e}"


if __name__ == "__main__":
    t = threading.Thread(target=background_mirror_loop, daemon=True)
    t.start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), LabHandler)
    print(f"[Workbench Lab Server] Running on http://127.0.0.1:{PORT} | Mirroring Gist {LAB_GIST_ID} -> {DATA_DIR}", flush=True)
    server.serve_forever()
