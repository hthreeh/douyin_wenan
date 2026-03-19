from __future__ import annotations

import contextlib
import io
import json
import re
import wave
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError as exc:  # pragma: no cover
    raise RuntimeError(
        "Missing dependency: requests. Install with `pip install -r requirements.txt`."
    ) from exc

try:
    from gradio_client import Client, handle_file
except ImportError as exc:  # pragma: no cover
    raise RuntimeError(
        "Missing dependency: gradio_client. Install with `pip install -r requirements.txt`."
    ) from exc

_GRADIO_CLIENT_CACHE: dict[str, Any] = {}
_GRADIO_RUN_PARAMS_CACHE: dict[str, set[str]] = {}


def _run_quietly(func: Any, *args: Any, **kwargs: Any) -> Any:
    """Suppress noisy stdout/stderr emitted by gradio_client internals."""
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(
        stderr_buffer
    ):
        return func(*args, **kwargs)


def _to_seconds(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)

    text = str(value).strip()
    if not text:
        return 0.0

    try:
        return float(text)
    except ValueError:
        pass

    if ":" in text:
        parts = text.split(":")
        if len(parts) == 3:
            try:
                hours = float(parts[0])
                minutes = float(parts[1])
                seconds = float(parts[2])
                return hours * 3600 + minutes * 60 + seconds
            except ValueError:
                return 0.0
    return 0.0


def _to_serializable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {str(k): _to_serializable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_to_serializable(item) for item in value]
        if hasattr(value, "__dict__"):
            return _to_serializable(vars(value))
        return str(value)


def _language_to_gradio_display(language: str | None) -> str:
    if not language:
        return "Auto"
    normalized = language.strip().lower()
    mapping = {
        "auto": "Auto",
        "zh": "Chinese",
        "zh-cn": "Chinese",
        "en": "English",
        "ja": "Japanese",
        "ko": "Korean",
        "yue": "Cantonese",
    }
    return mapping.get(normalized, "Auto")


def _get_gradio_client(gradio_url: str) -> Any:
    url = gradio_url.strip().rstrip("/")
    if not url:
        raise ValueError("Gradio URL cannot be empty.")

    cached = _GRADIO_CLIENT_CACHE.get(url)
    if cached is not None:
        return cached

    client = _run_quietly(Client, url)
    _GRADIO_CLIENT_CACHE[url] = client
    return client


def _fetch_gradio_run_params(gradio_url: str) -> set[str]:
    url = gradio_url.strip().rstrip("/")
    cached = _GRADIO_RUN_PARAMS_CACHE.get(url)
    if cached is not None:
        return cached

    request_url = f"{url}/gradio_api/info"
    session = requests.Session()
    if url.startswith("http://localhost") or url.startswith("http://127.0.0.1"):
        session.trust_env = False

    try:
        response = session.get(request_url, timeout=10)
        response.raise_for_status()
        payload = response.json()
    except Exception:
        fallback = {"audio_upload", "lang_disp", "return_ts"}
        _GRADIO_RUN_PARAMS_CACHE[url] = fallback
        return fallback

    params: set[str] = set()
    named_endpoints = payload.get("named_endpoints")
    if isinstance(named_endpoints, dict):
        run_endpoint = named_endpoints.get("/run")
        if isinstance(run_endpoint, dict):
            endpoint_params = run_endpoint.get("parameters")
            if isinstance(endpoint_params, list):
                for item in endpoint_params:
                    if isinstance(item, dict):
                        name = str(item.get("parameter_name") or "").strip()
                        if name:
                            params.add(name)

    if not params:
        params = {"audio_upload", "lang_disp", "return_ts"}
    _GRADIO_RUN_PARAMS_CACHE[url] = params
    return params


def _audio_duration_seconds(audio_path: Path) -> float:
    try:
        with wave.open(str(audio_path), "rb") as wav_file:
            frame_rate = wav_file.getframerate()
            frames = wav_file.getnframes()
        if frame_rate > 0:
            return max(0.0, frames / float(frame_rate))
    except Exception:
        return 0.0
    return 0.0


def _estimate_segments_from_text(text: str, audio_path: Path) -> list[dict[str, Any]]:
    clean = text.strip()
    if not clean:
        return []

    chunks = [
        chunk.strip()
        for chunk in re.findall(r"[^。！？!?；;\n]+[。！？!?；;]?", clean)
        if chunk.strip()
    ]
    if not chunks:
        chunks = [clean]

    duration = _audio_duration_seconds(audio_path)
    if duration <= 0:
        duration = max(1.0, len(clean) * 0.12)

    total_weight = sum(max(1, len(chunk)) for chunk in chunks)
    cursor = 0.0
    segments: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks, start=1):
        weight = max(1, len(chunk))
        seg_duration = duration * (weight / total_weight)
        start = cursor
        end = duration if index == len(chunks) else min(duration, cursor + seg_duration)
        if end <= start:
            end = min(duration, start + 0.2)
        segments.append(
            {
                "id": index,
                "start": round(start, 3),
                "end": round(end, 3),
                "text": chunk,
            }
        )
        cursor = end
    return segments


def transcribe_audio(
    audio_path: Path,
    gradio_url: str,
    language: str | None = None,
) -> dict[str, Any]:
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    client = _get_gradio_client(gradio_url)
    run_params = _fetch_gradio_run_params(gradio_url)
    lang_display = _language_to_gradio_display(language)

    audio_param_name = "audio_upload"
    for candidate in ("audio_upload", "audio", "audio_input", "audio_file"):
        if candidate in run_params:
            audio_param_name = candidate
            break

    language_param_name: str | None = None
    for candidate in ("lang_disp", "language", "lang", "language_input"):
        if candidate in run_params:
            language_param_name = candidate
            break

    return_ts_param_name: str | None = None
    for candidate in (
        "return_ts",
        "return_timestamps",
        "return_time_stamps",
        "with_timestamps",
        "timestamps",
    ):
        if candidate in run_params:
            return_ts_param_name = candidate
            break

    predict_kwargs: dict[str, Any] = {
        audio_param_name: handle_file(str(audio_path)),
        "api_name": "/run",
    }
    if language_param_name:
        predict_kwargs[language_param_name] = lang_display
    if return_ts_param_name:
        predict_kwargs[return_ts_param_name] = True

    try:
        result = _run_quietly(client.predict, **predict_kwargs)
    except Exception:
        if lang_display != "Auto" and language_param_name:
            predict_kwargs[language_param_name] = "Auto"
            result = _run_quietly(client.predict, **predict_kwargs)
            lang_display = "Auto"
        else:
            raise

    values = list(result) if isinstance(result, (list, tuple)) else [result]
    detected_language = str(values[0] if len(values) > 0 else "").strip()
    text = str(values[1] if len(values) > 1 else "").strip()
    raw_timestamps = values[2] if len(values) > 2 else None
    if isinstance(raw_timestamps, dict) and "value" in raw_timestamps:
        raw_timestamps = raw_timestamps.get("value")

    segments: list[dict[str, Any]] = []
    if isinstance(raw_timestamps, list):
        for item in raw_timestamps:
            if not isinstance(item, dict):
                continue
            seg_text = str(item.get("text") or "").strip()
            if not seg_text:
                continue
            start = _to_seconds(item.get("start_time") or item.get("start"))
            end = _to_seconds(item.get("end_time") or item.get("end"))
            if end < start:
                end = start
            segments.append(
                {
                    "id": len(segments) + 1,
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "text": seg_text,
                }
            )

    if not text and segments:
        text = " ".join(seg["text"] for seg in segments).strip()
    if text and not segments:
        segments = _estimate_segments_from_text(text, audio_path)
    if text and not segments:
        segments = [{"id": 1, "start": 0.0, "end": 0.2, "text": text}]

    return {
        "text": text,
        "segments": segments,
        "raw_response": {
            "detected_language": detected_language,
            "requested_language": lang_display,
            "run_params": sorted(run_params),
            "gradio_result": _to_serializable(values),
        },
    }
