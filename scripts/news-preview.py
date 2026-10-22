"""Prepare short inference previews without a tokenizer dependency."""

import json
import re
import sys
import unicodedata


def approximate_tokens(text):
    """Estimate one token per four Latin characters or one wide character."""
    return sum(
        0 if unicodedata.combining(char)
        else 1 if unicodedata.east_asian_width(char) in ("W", "F")
        else 0.25
        for char in text
    )


def truncate_preview(value, max_tokens=40):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"https?://\S+", "[link]", text, flags=re.IGNORECASE)
    if not text:
        return "none"
    if approximate_tokens(text) <= max_tokens:
        return text

    # Reserve room for the ellipsis. This is an estimate, not a tokenizer cap.
    budget = max_tokens - 1
    used = 0
    end = 0
    for index, char in enumerate(text):
        cost = approximate_tokens(char)
        if used + cost > budget:
            break
        used += cost
        end = index + 1

    prefix = text[:end]
    # Prefer a whole word for whitespace-delimited scripts. Wide characters can
    # be cut directly, so a Japanese paragraph does not become an empty preview.
    if (end < len(text) and prefix and prefix[-1].isalnum()
            and text[end].isalnum()
            and unicodedata.east_asian_width(text[end]) not in ("W", "F")):
        boundary = prefix.rfind(" ")
        if boundary > 0:
            prefix = prefix[:boundary]
    return prefix.rstrip() + "…"


if __name__ == "__main__":
    json.dump([truncate_preview(value) for value in json.load(sys.stdin)],
              sys.stdout, ensure_ascii=False)
