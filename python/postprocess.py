from __future__ import annotations

import re
from typing import Any

FILLER_WORDS = (
    "um",
    "uh",
    "er",
    "ah",
    "like",
    "you know",
    "嗯",
    "啊",
    "呃",
)


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def clean_text(text: str, remove_fillers: bool = False) -> str:
    cleaned = _normalize_whitespace(text)
    if not remove_fillers or not cleaned:
        return cleaned

    for word in FILLER_WORDS:
        pattern = rf"\b{re.escape(word)}\b"
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
    return _normalize_whitespace(cleaned)


def clean_segments(
    segments: list[dict[str, Any]], remove_fillers: bool = False
) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for seg in segments:
        text = clean_text(str(seg.get("text") or ""), remove_fillers=remove_fillers)
        if not text:
            continue
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        if end < start:
            end = start
        cleaned.append(
            {
                "id": len(cleaned) + 1,
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
            }
        )
    return cleaned
