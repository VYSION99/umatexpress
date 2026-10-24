"""Bounded, deterministic suggestions for repeated audience questions."""

import re

STOP_WORDS = frozenset({
    "a", "about", "and", "are", "can", "could", "do", "does", "for", "how",
    "i", "in", "is", "it", "of", "on", "our", "please", "the", "this",
    "to", "we", "what", "when", "why", "would", "you",
})


def terms(text: str) -> set[str]:
    return {word for word in re.findall(r"[\w]+", text.casefold())
            if len(word) >= 3 and word not in STOP_WORDS}


def suggest_groups(questions: list[dict]) -> list[list[str]]:
    """Group close wording under the first question; never make moderation decisions."""
    groups: list[list[str]] = []
    anchors: list[set[str]] = []
    for question in questions[:100]:
        words = terms(question["text"])
        if not words:
            continue
        matched = next((index for index, anchor in enumerate(anchors)
                        if len(words & anchor) >= 2
                        and len(words & anchor) / len(words | anchor) >= 0.5), None)
        if matched is None:
            anchors.append(words)
            groups.append([question["id"]])
        else:
            groups[matched].append(question["id"])
    return [group for group in groups if len(group) > 1]
