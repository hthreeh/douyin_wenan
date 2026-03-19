from __future__ import annotations

import argparse
import json
import platform
import sys
from pathlib import Path

from asr_qwen import transcribe_audio
from exporters import write_srt, write_txt
from extract_audio import ensure_ffmpeg_available, extract_audio
from postprocess import clean_segments, clean_text


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bridge for local video -> transcript flow.")
    parser.add_argument("--input", help="Input video file.")
    parser.add_argument("--output-dir", help="Directory for generated transcript files.")
    parser.add_argument(
        "--backend",
        default="gradio",
        choices=["gradio"],
        help="ASR backend. v1 only supports gradio.",
    )
    parser.add_argument(
        "--gradio-url",
        default="http://127.0.0.1:8000",
        help="Local Qwen ASR Gradio URL.",
    )
    parser.add_argument("--language", default=None, help="Optional language code.")
    parser.add_argument(
        "--remove-fillers",
        action="store_true",
        help="Apply light filler-word cleanup in postprocess.",
    )
    parser.add_argument(
        "--keep-audio",
        action="store_true",
        help="Keep intermediate wav file.",
    )
    parser.add_argument(
        "--health-check",
        action="store_true",
        help="Verify Python bridge dependencies and print JSON.",
    )
    return parser.parse_args()


def health_check() -> int:
    ffmpeg_bin = ensure_ffmpeg_available("ffmpeg")
    payload = {
        "ok": True,
        "python_version": platform.python_version(),
        "python_executable": sys.executable,
        "ffmpeg_bin": ffmpeg_bin,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def main() -> int:
    args = parse_args()

    try:
        if args.health_check:
            return health_check()

        if not args.input or not args.output_dir:
            raise ValueError("--input and --output-dir are required unless --health-check is used.")

        input_path = Path(args.input).expanduser().resolve()
        output_dir = Path(args.output_dir).expanduser().resolve()

        if not input_path.exists():
            raise FileNotFoundError(f"Input video does not exist: {input_path}")
        if input_path.is_dir():
            raise ValueError("--input must be a video file, not a directory.")

        output_dir.mkdir(parents=True, exist_ok=True)
        ffmpeg_bin = ensure_ffmpeg_available("ffmpeg")

        wav_path = output_dir / "audio.wav"
        txt_path = output_dir / "transcript.txt"
        srt_path = output_dir / "transcript.srt"

        extract_audio(
            video_path=input_path,
            output_path=wav_path,
            ffmpeg_bin=ffmpeg_bin,
            sample_rate=16000,
            channels=1,
        )
        result = transcribe_audio(
            audio_path=wav_path,
            gradio_url=args.gradio_url,
            language=args.language,
        )

        cleaned_text = clean_text(
            result.get("text", ""), remove_fillers=args.remove_fillers
        )
        cleaned_segments = clean_segments(
            result.get("segments", []), remove_fillers=args.remove_fillers
        )

        write_txt(cleaned_text, txt_path)
        write_srt(cleaned_segments, srt_path)
        srt_text = srt_path.read_text(encoding="utf-8")

        if not args.keep_audio and wav_path.exists():
            wav_path.unlink()

        payload = {
            "ok": True,
            "text": cleaned_text,
            "srt_text": srt_text,
            "txt_path": str(txt_path),
            "srt_path": str(srt_path),
            "backend": args.backend,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
