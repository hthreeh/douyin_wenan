from __future__ import annotations

import subprocess
from pathlib import Path
from shutil import which


def resolve_ffmpeg_bin(ffmpeg_bin: str = "ffmpeg") -> str:
    if ffmpeg_bin and which(ffmpeg_bin):
        return ffmpeg_bin
    if ffmpeg_bin and Path(ffmpeg_bin).exists():
        return ffmpeg_bin

    try:
        import imageio_ffmpeg
    except ImportError:
        imageio_ffmpeg = None

    if imageio_ffmpeg is not None:
        fallback_bin = imageio_ffmpeg.get_ffmpeg_exe()
        if fallback_bin and Path(fallback_bin).exists():
            return fallback_bin

    raise RuntimeError(
        f"ffmpeg not found: {ffmpeg_bin}. Install ffmpeg or set FFMPEG_BIN."
    )


def ensure_ffmpeg_available(ffmpeg_bin: str = "ffmpeg") -> str:
    resolved = resolve_ffmpeg_bin(ffmpeg_bin)
    completed = subprocess.run(
        [resolved, "-version"],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        error_text = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"ffmpeg check failed: {error_text}")
    return resolved


def extract_audio(
    video_path: Path,
    output_path: Path,
    ffmpeg_bin: str = "ffmpeg",
    sample_rate: int = 16000,
    channels: int = 1,
    overwrite: bool = True,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    command = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y" if overwrite else "-n",
        "-i",
        str(video_path),
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        str(sample_rate),
        "-ac",
        str(channels),
        str(output_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        raise RuntimeError(f"ffmpeg audio extraction failed: {stderr}")

    if not output_path.exists():
        raise RuntimeError(f"Expected output audio file not found: {output_path}")
    return output_path
