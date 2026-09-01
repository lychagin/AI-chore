"""Слой 3: цепочки писем и новизна содержимого.

Каждое следующее письмо тянет за собой всю предыдущую переписку, и полезное
в нём — только то, чего не было раньше. Причём новое не обязано быть сверху:
ответы часто вставлены в глубину цитаты. Поэтому сравниваем не «до цитаты /
после цитаты», а поабзацно со всеми предыдущими письмами цепочки.

Сравнение идёт по готовому markdown, а не по HTML: почтовые клиенты
перепаковывают разметку при каждом ответе, но текст абзаца сохраняют.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

RE_PREFIX = re.compile(r'^\s*((RE|FW|FWD|ОТВ|ПЕР)\s*(\[\d+\])?\s*:\s*)+', re.IGNORECASE)
MARKUP_RE = re.compile(r'!\[[^\]]*\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)|[*_`>#|-]')
TOKEN_RE = re.compile(r'@@REPLY:[A-Z]\d+@@|@@REPLYEND@@')
QUOTE_HEADER_RE = re.compile(
    r'^(from|от|sent|дата|to|кому|cc|копия|subject|тема)\s*[:*]', re.IGNORECASE
)


@dataclass
class ThreadMember:
    key: str
    message_id: str | None
    date: datetime | None
    paragraphs: list[str] = field(default_factory=list)
    new_paragraphs: list[str] = field(default_factory=list)
    position: int = 0
    total: int = 1


def normalize_subject(subject: str) -> str:
    """RE: RE: FW: Тема -> тема"""
    without_prefix = RE_PREFIX.sub('', subject or '')
    return re.sub(r'\s+', ' ', without_prefix).strip().lower()


def is_quote_header(text: str) -> bool:
    """Служебная шапка цитаты (От:/Дата:/Кому:/Тема:).

    Формально она новая в каждом письме — но фактов не несёт и только
    зашумляет разметку новизны.
    """
    stripped = re.sub(r'^[*_>\s]+', '', text)
    return bool(QUOTE_HEADER_RE.match(stripped))


def paragraph_key(text: str) -> str | None:
    """Нормализованный текст абзаца, устойчивый к перепаковке разметки.

    Не хеш: сравнение идёт вхождением в накопленный текст предыдущих писем, а
    не равенством. Outlook произвольно меняет границы абзацев между раундами —
    один и тот же текст приходит то одним блоком на 1128 символов, то блоком
    на 45, и равенство отпечатков такое не переживает.
    """
    cleaned = TOKEN_RE.sub(' ', text)
    cleaned = MARKUP_RE.sub(' ', cleaned)
    cleaned = re.sub(r'https?://\S+|mailto:\S+', ' ', cleaned)
    cleaned = re.sub(r'[^\w\s]', ' ', cleaned, flags=re.UNICODE)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip().lower()
    return cleaned or None


def split_paragraphs(markdown: str) -> list[str]:
    blocks = [block.strip() for block in re.split(r'\n\s*\n', markdown)]
    return [block for block in blocks if block]


def _sort_key(member: ThreadMember) -> tuple:
    if member.date is not None:
        return (0, member.date)
    return (1, datetime.max.replace(tzinfo=timezone.utc))


def build_threads(members: list[ThreadMember], subjects: dict[str, str]) -> dict[str, list]:
    """Группирует письма по нормализованной теме и упорядочивает по дате."""
    threads: dict[str, list[ThreadMember]] = {}
    for member in members:
        threads.setdefault(normalize_subject(subjects[member.key]), []).append(member)
    for chain in threads.values():
        chain.sort(key=_sort_key)
        for index, member in enumerate(chain):
            member.position = index + 1
            member.total = len(chain)
    return threads


def mark_new_content(threads: dict[str, list]) -> None:
    """Отмечает абзацы, которых не было ни в одном предыдущем письме цепочки.

    Абзац считается known, если его нормализованный текст ВХОДИТ в текст
    предыдущих писем. Вхождение, а не равенство: почтовый клиент перекраивает
    границы абзацев, и одна и та же реплика приходит то отдельным блоком, то
    склеенной с соседними.

    Побочно это гасит шум коротких реплик: «ок» и «да» встречаются в корпусе
    всегда, поэтому новыми не помечаются, — и при этом короткий, но реально
    новый ответ («Про длительность – ок») метку получает.
    """
    for chain in threads.values():
        corpus = ''
        for member in chain:
            fresh = []
            own: list[str] = []
            for block in member.paragraphs:
                text = paragraph_key(block)
                if text is None or is_quote_header(block):
                    continue
                own.append(text)
                if text not in corpus:
                    fresh.append(block)
            # Первое письмо цепочки новым не размечаем: сравнивать не с чем.
            member.new_paragraphs = fresh if member.position > 1 else []
            corpus = f'{corpus} {" ".join(own)}'
