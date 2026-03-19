from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

PROJECT_DIR = Path(__file__).resolve().parent
MODEL_HOST = os.getenv("MODEL_HOST", "127.0.0.1")
MODEL_PORT = int(os.getenv("MODEL_PORT", "8000"))
WEB_HOST = os.getenv("WEB_HOST", "127.0.0.1")
WEB_PORT = int(os.getenv("PORT", "3000"))
ASR_BACKEND = "transformers"
CUDA_VISIBLE_DEVICES = "0"
BACKEND_KWARGS = {
    "device_map": "cuda:0",
    "dtype": "bfloat16",
    "max_inference_batch_size": 8,
    "max_new_tokens": 2048,
}
ALIGNER_KWARGS = {
    "device_map": "cuda:0",
    "dtype": "bfloat16",
}


def _no_proxy_env(base_env: dict[str, str]) -> dict[str, str]:
    env = dict(base_env)
    for key in ("NO_PROXY", "no_proxy"):
        existing = env.get(key, "")
        parts = [part.strip() for part in existing.split(",") if part.strip()]
        for host in ("localhost", "127.0.0.1"):
            if host not in parts:
                parts.append(host)
        env[key] = ",".join(parts)
    return env


def _http_alive(url: str, timeout_seconds: float = 2.0) -> bool:
    opener = build_opener(ProxyHandler({}))
    request = Request(url=url, method="GET")
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            return 200 <= response.status < 500
    except HTTPError as exc:
        return 200 <= exc.code < 500
    except (URLError, TimeoutError, OSError):
        return False


def _wait_http(url: str, max_wait_seconds: int) -> bool:
    deadline = time.time() + max_wait_seconds
    while time.time() < deadline:
        if _http_alive(url):
            return True
        time.sleep(1.0)
    return False


def _find_python() -> str:
    candidates = [
        Path(os.getenv("PYTHON_BIN", "")).expanduser() if os.getenv("PYTHON_BIN") else None,
        Path(r"F:\qwen_asr\qwen_asr_env\Scripts\python.exe"),
        PROJECT_DIR / ".venv" / "Scripts" / "python.exe",
        Path(sys.executable),
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return str(candidate)
    return "python"


def _find_node() -> str:
    explicit = os.getenv("NODE_BIN", "").strip()
    if explicit:
        return explicit
    found = shutil.which("node")
    if found:
        return found
    raise RuntimeError("node executable not found on PATH.")


def _find_asr_checkpoint() -> str:
    explicit = os.getenv("QWEN_ASR_CHECKPOINT", "").strip()
    if explicit:
        return explicit

    candidates = [
        PROJECT_DIR / "models" / "Qwen3-ASR-1.7B",
        PROJECT_DIR / "Qwen3-ASR-1.7B",
    ]
    for candidate in candidates:
        if (candidate / "config.json").exists():
            return str(candidate)
    return "Qwen/Qwen3-ASR-1.7B"


def _find_aligner_checkpoint() -> str:
    explicit = os.getenv("QWEN_ALIGNER_CHECKPOINT", "").strip()
    if explicit:
        return explicit

    candidates = [
        PROJECT_DIR / "models" / "Qwen3-ForcedAligner-0.6B",
        PROJECT_DIR / "Qwen3-ForcedAligner-0.6B",
    ]
    for candidate in candidates:
        if (candidate / "config.json").exists():
            return str(candidate)
    return "Qwen/Qwen3-ForcedAligner-0.6B"


def _start_process(command: list[str], env: dict[str, str]) -> None:
    creation_flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    subprocess.Popen(
        command,
        cwd=str(PROJECT_DIR),
        env=env,
        creationflags=creation_flags,
    )


def main() -> int:
    python_exe = _find_python()
    node_exe = _find_node()
    asr_checkpoint = _find_asr_checkpoint()
    aligner_checkpoint = _find_aligner_checkpoint()

    model_url = f"http://{MODEL_HOST}:{MODEL_PORT}/gradio_api/info"
    web_health_url = f"http://{WEB_HOST}:{WEB_PORT}/api/health"
    web_url = f"http://{WEB_HOST}:{WEB_PORT}"

    env = _no_proxy_env(os.environ)
    env["QWEN_GRADIO_URL"] = f"http://{MODEL_HOST}:{MODEL_PORT}"
    env["PYTHON_BIN"] = python_exe
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    print(f"[info] project dir: {PROJECT_DIR}")
    print(f"[info] python: {python_exe}")
    print(f"[info] node: {node_exe}")
    print(f"[info] asr checkpoint: {asr_checkpoint}")
    print(f"[info] aligner checkpoint: {aligner_checkpoint}")

    if _http_alive(model_url):
        print(f"[info] qwen asr service already running on :{MODEL_PORT}")
    else:
        model_command = [
            python_exe,
            "-m",
            "qwen_asr.cli.demo",
            "--asr-checkpoint",
            asr_checkpoint,
            "--aligner-checkpoint",
            aligner_checkpoint,
            "--backend",
            ASR_BACKEND,
            "--cuda-visible-devices",
            CUDA_VISIBLE_DEVICES,
            "--backend-kwargs",
            json.dumps(BACKEND_KWARGS, ensure_ascii=False),
            "--aligner-kwargs",
            json.dumps(ALIGNER_KWARGS, ensure_ascii=False),
            "--ip",
            MODEL_HOST,
            "--port",
            str(MODEL_PORT),
            "--no-share",
        ]
        _start_process(model_command, env=env)
        print("[info] qwen asr service starting...")

    if _http_alive(web_health_url):
        print(f"[info] web app already running on :{WEB_PORT}")
    else:
        web_command = [node_exe, "server.js"]
        _start_process(web_command, env=env)
        print("[info] web app starting...")

    if _wait_http(web_health_url, max_wait_seconds=60):
        print(f"[info] opening browser: {web_url}")
        webbrowser.open(web_url)
        return 0

    print("[warn] web app did not become ready in 60s")
    print(f"[hint] open manually: {web_url}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
