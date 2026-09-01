"""Слой 1: выделение inline-вставок по цвету шрифта.

В деловой переписке ответ часто вставлен внутрь цитаты и отличается только
цветом (interleaved posting). Цвет — штатный механизм почтовых клиентов,
поэтому он извлекается детерминированно: считаем эффективный цвет каждого
текстового узла с учётом наследования, вычитаем базовый цвет письма и
отбрасываем заведомо служебные зоны (ссылки, подписи).

Цвет кодирует раунд правки, а НЕ личность автора: сопоставление цвета с
человеком делается отдельно (слой 2) и сюда не относится.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from bs4 import NavigableString

REPLY_OPEN = '@@REPLY:{group}@@'
REPLY_CLOSE = '@@REPLYEND@@'
REPLY_OPEN_RE = re.compile(r'@@REPLY:([A-Z]\d+)@@')

# Фрагмент короче этого не считаем самостоятельной вставкой при подсчёте базы.
MIN_FRAGMENT_CHARS = 2
# Цвет становится кандидатом в маркеры, только если набрал столько символов.
MIN_COLOR_CHARS = 15
# Сколько узлов перед маркером подписи тоже считать подписью (имя, должность).
SIGNATURE_LOOKBEHIND = 4
# Разброс между каналами RGB, ниже которого цвет считается нейтральным.
NEUTRAL_SPREAD = 30

NAMED_COLORS = {
    'black': '#000000',
    'windowtext': '#000000',
    'white': '#ffffff',
    'blue': '#0000ff',
    'red': '#ff0000',
    'green': '#008000',
    'gray': '#808080',
    'grey': '#808080',
    'navy': '#000080',
    'purple': '#800080',
    'orange': '#ffa500',
    'maroon': '#800000',
    'teal': '#008080',
    'silver': '#c0c0c0',
}

# Подпись и служебные зоны — их цвета не являются ответами.
SIGNATURE_RE = re.compile(
    r'(с уважением|best regards|kind regards|с ув\.|'
    r'руководитель проектной группы|ux/ui designer|моб\.\s*:|тел\.\s*:)',
    re.IGNORECASE,
)
# Заголовки цитируемых писем: From/От/Sent/Тема и т.п.
QUOTE_HEADER_RE = re.compile(
    r'^\s*(from|от|sent|дата|to|кому|cc|копия|subject|тема)\s*:', re.IGNORECASE
)
# Только строка отправителя: за ней идёт узел с именем автора цитируемого письма.
FROM_HEADER_RE = re.compile(r'^\s*(from|от)\s*:\s*$', re.IGNORECASE)

# Фраза, которой автор сам объявляет цветовой код.
LEGEND_RE = re.compile(
    r'[^.!?\n]*\b(выдел\w+|отмет\w+|пишу|ответы?)\b[^.!?\n]*\b'
    r'(оранжев\w+|син\w+|красн\w+|зелён\w+|зелен\w+|цвет\w*|шрифт\w*)\b[^.!?\n]*',
    re.IGNORECASE,
)


@dataclass
class ColorGroup:
    """Один цвет-маркер и всё, что им написано."""

    group_id: str
    color: str
    fragments: int = 0
    chars: int = 0
    samples: list[str] = field(default_factory=list)

    @property
    def sample(self) -> str:
        for text in self.samples:
            if len(text) > 12:
                return text[:120]
        return self.samples[0][:120] if self.samples else ''


def normalize_color(raw: str | None) -> str | None:
    """Приводит цвет к #rrggbb. None — если цвет не задан или наследуется."""
    if not raw:
        return None
    value = raw.strip().lower().rstrip(';')
    if value in ('auto', 'inherit', 'initial', 'currentcolor', 'transparent'):
        return None
    if value in NAMED_COLORS:
        return NAMED_COLORS[value]
    match = re.match(r'#([0-9a-f]{3})$', value)
    if match:
        digits = match.group(1)
        return '#' + ''.join(char * 2 for char in digits)
    if re.match(r'#[0-9a-f]{6}$', value):
        return value
    match = re.match(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)', value)
    if match:
        return '#{:02x}{:02x}{:02x}'.format(*(int(g) for g in match.groups()[:3]))
    return None


def is_neutral(color: str) -> bool:
    """Чёрный, серый, белый — то есть цвет обычного текста, а не выделения."""
    red, green, blue = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    return max(red, green, blue) - min(red, green, blue) < NEUTRAL_SPREAD


def _own_color(tag) -> str | None:
    """Цвет, заданный на самом теге (style="color:" или <font color=>)."""
    style = tag.get('style') or ''
    # (?<!-) отсекает border-color / background-color.
    match = re.search(r'(?<![-\w])color\s*:\s*([^;]+)', style, re.IGNORECASE)
    if match:
        return normalize_color(match.group(1))
    return normalize_color(tag.get('color'))


def _effective_color(node: NavigableString, cache: dict[int, str | None]) -> str | None:
    """Цвет текстового узла с учётом наследования от родителей."""
    for parent in node.parents:
        if parent.name is None:
            break
        key = id(parent)
        if key in cache:
            inherited = cache[key]
            if inherited is not None:
                return inherited
            continue
        color = _own_color(parent)
        cache[key] = color
        if color is not None:
            return color
    return None


def _in_link(node: NavigableString) -> bool:
    """Ссылки почти всегда синие по умолчанию — это не маркер ответа."""
    return any(parent.name == 'a' for parent in node.parents)


def _collect_nodes(soup) -> list[NavigableString]:
    nodes = []
    for node in soup.find_all(string=True):
        if not isinstance(node, NavigableString):
            continue
        if any(p.name in ('style', 'script', 'title', 'head') for p in node.parents):
            continue
        if not node.strip():
            continue
        nodes.append(node)
    return nodes


def _signature_indexes(nodes: list[NavigableString]) -> set[int]:
    """Индексы узлов, попавших в зону подписи.

    Подпись тянется от маркера («С уважением») до заголовка следующей цитаты.
    """
    marked: set[int] = set()
    in_signature = False
    for index, node in enumerate(nodes):
        text = node.strip()
        if QUOTE_HEADER_RE.match(text):
            in_signature = False
        if SIGNATURE_RE.search(text):
            in_signature = True
            # Имя и должность обычно стоят выше маркера («С уважением»), а
            # набраны тем же цветом — иначе подпись попадёт в ответы.
            marked.update(range(max(0, index - SIGNATURE_LOOKBEHIND), index))
        if in_signature:
            marked.add(index)
    return marked


def annotate(soup) -> tuple[list[ColorGroup], str | None]:
    """Расставляет в дереве токены вставок. Возвращает легенду и подсказку.

    Токены переживают markdownify как обычный текст и заменяются на читаемые
    метки уже в готовом markdown.
    """
    nodes = _collect_nodes(soup)
    if not nodes:
        return [], None

    signature = _signature_indexes(nodes)
    cache: dict[int, str | None] = {}
    colors: list[str | None] = []
    for index, node in enumerate(nodes):
        if index in signature or _in_link(node):
            colors.append(None)
            continue
        colors.append(_effective_color(node, cache))

    weight: dict[str, int] = defaultdict(int)
    for node, color in zip(nodes, colors):
        text = node.strip()
        if color and len(text) >= MIN_FRAGMENT_CHARS:
            weight[color] += len(text)
    if not weight:
        return [], None

    # Базовым считаем не самый объёмный цвет, а любой нейтральный (чёрный,
    # серый): выделяют ответы именно цветом, а доли объёма скачут от письма
    # к письму и делают разметку неустойчивой.
    neutral = {color for color in weight if is_neutral(color)}
    if not neutral:
        neutral = {max(weight, key=lambda color: weight[color])}

    candidates = {
        color: chars
        for color, chars in weight.items()
        if color not in neutral and chars >= MIN_COLOR_CHARS
    }
    if not candidates:
        return [], _find_legend(nodes)

    order = sorted(candidates, key=lambda color: -candidates[color])
    groups = {color: ColorGroup(f'A{i + 1}', color) for i, color in enumerate(order)}

    # Расстановка токенов: открываем на входе в цветной участок, закрываем на выходе.
    previous: str | None = None
    pending_close: NavigableString | None = None
    for node, color in zip(nodes, colors):
        marker = color if color in groups else None
        if marker != previous:
            if previous is not None and pending_close is not None:
                pending_close.insert_after(NavigableString(f' {REPLY_CLOSE} '))
            if marker is not None:
                token = REPLY_OPEN.format(group=groups[marker].group_id)
                node.insert_before(NavigableString(f' {token} '))
            previous = marker
        if marker is not None:
            group = groups[marker]
            group.fragments += 1
            text = node.strip()
            group.chars += len(text)
            if len(group.samples) < 5:
                group.samples.append(text)
        pending_close = node

    if previous is not None and pending_close is not None:
        pending_close.insert_after(NavigableString(f' {REPLY_CLOSE} '))

    return [groups[color] for color in order], _find_legend(nodes)


def _find_legend(nodes: list[NavigableString]) -> tuple[str, str | None] | None:
    """Ищет фразу, где автор объявляет цветовой код, вместе с её автором.

    Легенда почти всегда лежит внутри цитаты и принадлежит НЕ отправителю
    письма: «Ответы в тексте синим» пишет заказчик, а письмо приходит от
    исполнителя. Без автора такая подсказка инвертирует роли, поэтому
    возвращаем пару (фраза, автор); автор None — фраза из собственного текста.
    """
    author: str | None = None
    for index, node in enumerate(nodes[:60]):
        text = node.strip()
        if FROM_HEADER_RE.match(text):
            following = nodes[index + 1].strip() if index + 1 < len(nodes) else ''
            author = re.sub(r'\s+', ' ', following)[:120] or author
            continue
        match = LEGEND_RE.search(text)
        if match:
            return re.sub(r'\s+', ' ', match.group(0)).strip()[:200], author
    return None
