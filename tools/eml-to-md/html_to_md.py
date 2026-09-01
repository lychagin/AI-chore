"""Конвертация Outlook-HTML писем в Markdown.

Outlook отдаёт грязный HTML: mso-условные комментарии, <o:p>, таблицы-обёртки
вокруг обычного текста и таблицы, вложенные в ячейки других таблиц. Поэтому
markdownify применяется не к сырому дереву, а к очищенному, а таблицы
рендерятся отдельно — снизу вверх, чтобы вложенные успели стать текстом.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup, Comment, NavigableString
from markdownify import MarkdownConverter

import colors

TABLE_TOKEN = '@@TABLE{index}@@'
TABLE_TOKEN_RE = re.compile(r'@@TABLE(\d+)@@')
QUOTE_TOKEN = '@@QUOTEBOUNDARY@@'
QUOTE_HEADING = '## Цитируемая переписка'

# Начало цитаты в письмах Outlook на русском и английском.
QUOTE_START_RE = re.compile(r'^\s*(From|От|Sent|Отправлено)\s*:', re.IGNORECASE)


class EmailConverter(MarkdownConverter):
    """markdownify без агрессивного экранирования — письма читают люди."""

    class Options(MarkdownConverter.DefaultOptions):
        heading_style = 'ATX'
        bullets = '-'
        escape_asterisks = False
        escape_underscores = False
        escape_misc = False
        strip = ['style', 'script']


def _drop_noise(soup: BeautifulSoup) -> None:
    """Удаляет то, что не несёт смысла: стили, mso-комментарии, <o:p>."""
    for tag in soup.find_all(['style', 'script', 'meta', 'link', 'title']):
        tag.decompose()
    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()
    for tag in soup.find_all(re.compile(r'^(o|v|w|m|st1):', re.IGNORECASE)):
        tag.unwrap()


def _rewrite_images(soup: BeautifulSoup, cid_map: dict[str, str]) -> None:
    """cid:xxx -> относительный путь к сохранённому вложению."""
    for img in soup.find_all('img'):
        src = (img.get('src') or '').strip()
        if not src.lower().startswith('cid:'):
            continue
        cid = src[4:].strip().strip('<>')
        target = cid_map.get(cid) or cid_map.get(cid.split('@')[0])
        if target:
            img['src'] = target
            img['alt'] = target.rsplit('/', 1)[-1]
        else:
            # Вложение не найдено — оставляем видимый след, а не битую ссылку.
            img.replace_with(NavigableString(f'[изображение отсутствует: {cid}]'))


def _is_layout_table(table) -> bool:
    """Таблица-обёртка Outlook: одна строка, одна ячейка."""
    rows = table.find_all('tr', recursive=False) or table.find_all('tr')
    if len(rows) != 1:
        return False
    cells = rows[0].find_all(['td', 'th'], recursive=False)
    return len(cells) == 1


def _cell_to_markdown(cell, converter: EmailConverter) -> str:
    """Содержимое ячейки в одну строку GFM: переносы становятся <br>."""
    text = converter.convert_soup(cell)
    text = text.replace('|', '\\|')
    lines = [line.strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    return '<br>'.join(lines).strip()


def _render_table(table, converter: EmailConverter) -> str:
    """Таблицу — в GFM. Первая строка становится заголовком."""
    rows = table.find_all('tr')
    if not rows:
        return ''
    grid = []
    for row in rows:
        cells = row.find_all(['td', 'th'])
        if not cells:
            continue
        grid.append([_cell_to_markdown(cell, converter) for cell in cells])
    if not grid:
        return ''

    width = max(len(row) for row in grid)
    grid = [row + [''] * (width - len(row)) for row in grid]

    header = grid[0]
    # Пустая шапка ломает читаемость таблицы — подставляем номера колонок.
    if not any(cell for cell in header):
        header = [f'Колонка {i + 1}' for i in range(width)]
        body = grid[1:]
    else:
        body = grid[1:]

    lines = ['| ' + ' | '.join(header) + ' |']
    lines.append('|' + '|'.join([' --- '] * width) + '|')
    for row in body:
        lines.append('| ' + ' | '.join(row) + ' |')
    return '\n'.join(lines)


def _extract_tables(soup: BeautifulSoup, converter: EmailConverter) -> list[str]:
    """Заменяет таблицы на токены, возвращает готовые GFM-блоки.

    Обход снизу вверх: к моменту рендера внешней таблицы вложенные уже
    превращены в токены и не порождают вложенный markdown.
    """
    rendered: list[str] = []
    tables = soup.find_all('table')
    for table in reversed(tables):
        if _is_layout_table(table):
            table.unwrap()
            continue
        markdown = _render_table(table, converter)
        if not markdown:
            table.decompose()
            continue
        token = TABLE_TOKEN.format(index=len(rendered))
        rendered.append(markdown)
        placeholder = soup.new_tag('p')
        placeholder.string = token
        table.replace_with(placeholder)
    return rendered


def _mark_quote_boundary(soup: BeautifulSoup) -> bool:
    """Ставит маркер перед началом цитируемой переписки. True, если нашёл."""
    candidate = soup.find(id='divRplyFwdMsg')
    if candidate is None:
        for tag in soup.find_all(['div', 'p']):
            style = (tag.get('style') or '').replace(' ', '').lower()
            if 'border-top:solid' not in style and 'border-top:1' not in style:
                continue
            if QUOTE_START_RE.match(tag.get_text(' ', strip=True)[:60]):
                candidate = tag
                break
    if candidate is None:
        return False
    marker = soup.new_tag('p')
    marker.string = QUOTE_TOKEN
    candidate.insert_before(marker)
    return True


def _tidy(text: str) -> str:
    # Outlook щедро сыплет CR внутрь абзацев — в markdown они видны как ^M.
    text = text.replace('\r\n', '\n').replace('\r', ' ')
    text = text.replace('\xa0', ' ').replace('​', '')
    text = re.sub(r'[ \t]+\n', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def convert(html: str, cid_map: dict[str, str]) -> tuple[str, list, str | None]:
    """HTML письма -> (markdown, группы inline-вставок, подсказка о цветах)."""
    soup = BeautifulSoup(html, 'lxml')
    converter = EmailConverter()

    _drop_noise(soup)
    # Цвета размечаем до вырезания таблиц, иначе вставки внутри них потеряются.
    groups, legend = colors.annotate(soup)
    _rewrite_images(soup, cid_map)
    has_quote = _mark_quote_boundary(soup)
    tables = _extract_tables(soup, converter)

    markdown = converter.convert_soup(soup)

    def _restore(match: re.Match) -> str:
        return '\n' + tables[int(match.group(1))] + '\n'

    markdown = TABLE_TOKEN_RE.sub(_restore, markdown)
    if has_quote:
        markdown = markdown.replace(QUOTE_TOKEN, f'\n---\n\n{QUOTE_HEADING}\n')

    markdown = colors.REPLY_OPEN_RE.sub(lambda m: f'**[вставка {m.group(1)}]** ', markdown)
    markdown = markdown.replace(colors.REPLY_CLOSE, ' **[/вставка]**')
    return _tidy(markdown), groups, legend


def convert_plain(text: str) -> str:
    """Фолбэк, когда у письма нет HTML-части."""
    return _tidy(text or '')
