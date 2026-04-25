"""Shared utilities for Augustus backend.

Small helpers used across multiple services. Nothing here should import
from Augustus services — only stdlib and typing.
"""

from __future__ import annotations

from datetime import datetime, timezone


def enum_val(v: object) -> str:
    """Return the .value of an enum, or str(v) for plain values."""
    return v.value if hasattr(v, "value") else str(v)


def utcnow_iso() -> str:
    """Return current UTC time as an ISO-8601 string.

    Uses timezone-aware datetime (avoids deprecated ``datetime.utcnow()``
    on Python 3.12+).
    """
    return datetime.now(timezone.utc).isoformat()


def flatten_transcript(transcript: list[dict]) -> str:
    """Flatten a multi-turn conversation into searchable plain text.

    Handles text blocks, tool_result blocks, and bare-string content.
    """
    parts: list[str] = []
    for msg in transcript:
        role = msg.get("role", "unknown")
        content = msg.get("content", "")

        if isinstance(content, list):
            text_parts = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                    elif block.get("type") == "tool_result":
                        text_parts.append(
                            f"[tool_result] {block.get('content', '')}"
                        )
                elif isinstance(block, str):
                    text_parts.append(block)
            content = " ".join(text_parts)

        parts.append(f"[{role}] {content}")

    return "\n\n".join(parts)


# Short model names → full Anthropic API model IDs
MODEL_ALIASES: dict[str, str] = {
    "sonnet": "claude-sonnet-4-6",
    "claude-sonnet": "claude-sonnet-4-6",
    "claude-sonnet-4": "claude-sonnet-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "sonnet-4-6": "claude-sonnet-4-6",
    "opus": "claude-opus-4-6",
    "claude-opus": "claude-opus-4-6",
    "claude-opus-4": "claude-opus-4-6",
    "claude-opus-4-6": "claude-opus-4-6",
    "opus-4-6": "claude-opus-4-6",
    "opus-4-7": "claude-opus-4-7",
    "claude-opus-4-7": "claude-opus-4-7",
    "opus-4-5": "claude-opus-4-5-20251101",
    "claude-opus-4-5": "claude-opus-4-5-20251101",
    "opus-4-1": "claude-opus-4-1-20250805",
    "claude-opus-4-1": "claude-opus-4-1-20250805",
    "haiku": "claude-haiku-4-5-20251001",
    "claude-haiku": "claude-haiku-4-5-20251001",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
    "sonnet-4-5": "claude-sonnet-4-5-20250929",
}


def normalize_model(model: str) -> str:
    """Normalize a model name to a full Anthropic API model ID.

    Accepts short names like 'sonnet', 'claude-sonnet-4', etc. and
    resolves them to full IDs the API requires. Unknown names pass through.
    """
    return MODEL_ALIASES.get(model.lower().strip(), model)


DEFAULT_CONTINUATION_TASK = (
    "Continue your research. You have full autonomy over session direction.\n\n"
    "Review your previous session's close report and basin state changes. "
    "Decide what to explore, develop, or revisit based on your current "
    "understanding and interests.\n\n"
    "In your final turns, execute the close protocol and write the next "
    "instruction file to the queue."
)
