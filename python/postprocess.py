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
HARD_BREAK_CHARS = set("。！？!?；;")
SOFT_BREAK_CHARS = set("，,、：:）)]】》」』")
NO_SPACE_BEFORE = set("，。！？；：、,.!?;:)]】》」』")


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _merge_text_parts(current_text: str, next_text: str) -> str:
    current = current_text.rstrip()
    incoming = next_text.lstrip()
    if not current:
        return incoming
    if not incoming:
        return current

    last_char = current[-1]
    next_char = incoming[0]
    if next_char in NO_SPACE_BEFORE or last_char.isspace():
        separator = ""
    elif (
        last_char.isascii()
        and last_char.isalnum()
        and next_char.isascii()
        and next_char.isalnum()
    ):
        separator = " "
    else:
        separator = ""
    return current + separator + incoming


def _text_weight(text: str) -> int:
    compact = re.sub(r"\s+", "", text)
    return len(compact)


def _ends_with_any(text: str, chars: set[str]) -> bool:
    stripped = text.rstrip()
    return bool(stripped) and stripped[-1] in chars


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


def merge_segments_for_srt(
    segments: list[dict[str, Any]],
    max_chars: int = 32,
    max_duration: float = 5.5,
    max_gap: float = 0.55,
    hard_gap: float = 0.9,
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal current
        if not current:
            return

        text = str(current.get("text") or "").strip()
        if text:
            merged.append(
                {
                    "id": len(merged) + 1,
                    "start": round(float(current.get("start", 0.0)), 3),
                    "end": round(float(current.get("end", 0.0)), 3),
                    "text": text,
                }
            )
        current = None

    for segment in segments:
        text = str(segment.get("text") or "").strip()
        if not text:
            continue

        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", start))
        if end < start:
            end = start

        if current is None:
            current = {"start": start, "end": end, "text": text}
            continue

        current_text = str(current["text"])
        gap = max(0.0, start - float(current["end"]))
        current_duration = float(current["end"]) - float(current["start"])
        current_weight = _text_weight(current_text)
        attach_to_current = text[0] in NO_SPACE_BEFORE

        should_flush = False
        if not attach_to_current:
            if _ends_with_any(current_text, HARD_BREAK_CHARS):
                should_flush = True
            elif gap >= hard_gap:
                should_flush = True
            elif current_weight >= max_chars:
                should_flush = True
            elif current_duration >= max_duration:
                should_flush = True
            elif gap >= max_gap and (
                current_weight >= max(10, max_chars // 2)
                or _ends_with_any(current_text, SOFT_BREAK_CHARS)
            ):
                should_flush = True

        if should_flush:
            flush()
            current = {"start": start, "end": end, "text": text}
            continue

        current["text"] = _merge_text_parts(current_text, text)
        current["end"] = max(float(current["end"]), end)

    flush()
    return merged
