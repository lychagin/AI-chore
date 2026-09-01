#!/usr/bin/env python3
"""Конвертер писем .eml/.msg в Markdown с разметкой вставок и новизны.

Имя результата повторяет имя исходника, меняется только расширение:
    2026-07-30-checkout.eml -> 2026-07-30-checkout.md

Помимо конвертации размечает две вещи, которые иначе теряются:
  - inline-вставки, отличённые автором цветом шрифта (слой 1, colors.py);
  - абзацы, которых не было в предыдущих письмах цепочки (слой 3, thread.py).

Обработка двухпроходная: новизна видна только на всей цепочке целиком,
поэтому сначала разбираются все письма, и лишь затем пишутся файлы —
передавать директорию целиком, а не файлы по одному.

Запуск и раскладка результата — см. README.md рядом:
    .venv/bin/python convert.py <файл-или-директория> [...] \
        [--out-dir DIR] [--attachments-dir DIR] [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import html_to_md
from message import Attachment, ParsedMessage, parse
from thread import (
    ThreadMember,
    build_threads,
    mark_new_content,
    normalize_subject,
    paragraph_key,
    split_paragraphs,
)

SUPPORTED = ('.eml', '.msg')
CID_IN_HTML_RE = re.compile(r'src=["\']cid:([^"\']+)["\']', re.IGNORECASE)
NEW_MARK = '**[NEW]**'
# Абзацы, которым метка новизны ломает разметку, помечаем строкой выше.
BLOCK_STARTS = ('|', '!', '#', '>', '---')


@dataclass
class Prepared:
    """Разобранное письмо до сборки итогового markdown."""

    path: Path
    parsed: ParsedMessage
    body: str
    groups: list = field(default_factory=list)
    legend: str | None = None
    cid_map: dict[str, str] = field(default_factory=dict)
    attachments_dir: Path | None = None
    link_prefix: str = ''
    out_path: Path | None = None


def _yaml_value(value: object) -> str:
    """Скалярное значение YAML в кавычках — в письмах полно двоеточий."""
    if value is None:
        return '""'
    text = str(value).replace('\\', '\\\\').replace('"', '\\"')
    return f'"{text}"'


def _unique_name(name: str, taken: set[str]) -> str:
    """Разводит одноимённые вложения: image001.png -> image001-2.png"""
    candidate = Path(name).name or 'attachment'
    if candidate not in taken:
        taken.add(candidate)
        return candidate
    stem, suffix = Path(candidate).stem, Path(candidate).suffix
    index = 2
    while f'{stem}-{index}{suffix}' in taken:
        index += 1
    candidate = f'{stem}-{index}{suffix}'
    taken.add(candidate)
    return candidate


def save_attachments(
    parsed: ParsedMessage, attachments_dir: Path, link_prefix: str, dry_run: bool
) -> dict[str, str]:
    """Пишет вложения на диск, возвращает карту Content-ID -> относительный путь."""
    if not parsed.attachments:
        return {}
    if not dry_run:
        attachments_dir.mkdir(parents=True, exist_ok=True)

    taken: set[str] = set()
    cid_map: dict[str, str] = {}
    for attachment in parsed.attachments:
        saved = _unique_name(attachment.filename, taken)
        attachment.saved_name = saved
        if not dry_run:
            (attachments_dir / saved).write_bytes(attachment.data)
        relative = f'{link_prefix}/{saved}'
        if attachment.cid:
            cid_map[attachment.cid] = relative
            cid_map.setdefault(attachment.cid.split('@')[0], relative)
    return cid_map


def mark_referenced(parsed: ParsedMessage) -> None:
    """Отмечает вложения, на которые ссылается тело письма."""
    referenced = {cid.strip().strip('<>') for cid in CID_IN_HTML_RE.findall(parsed.html or '')}
    bare = {cid.split('@')[0] for cid in referenced}
    for attachment in parsed.attachments:
        if not attachment.cid:
            continue
        attachment.referenced = (
            attachment.cid in referenced or attachment.cid.split('@')[0] in bare
        )


def render_frontmatter(prepared: Prepared, member: ThreadMember) -> str:
    parsed = prepared.parsed
    inline = sum(1 for a in parsed.attachments if a.is_inline)
    lines = ['---', f'source: {_yaml_value(parsed.source.name)}']
    for name in ('From', 'To', 'Cc'):
        if parsed.headers.get(name):
            lines.append(f'{name.lower()}: {_yaml_value(parsed.headers[name])}')
    lines.append(f'subject: {_yaml_value(parsed.subject)}')
    lines.append(f'date: {_yaml_value(parsed.date.isoformat() if parsed.date else "")}')
    lines.append(f'message_id: {_yaml_value(parsed.message_id)}')
    lines.append(f'in_reply_to: {_yaml_value(parsed.in_reply_to)}')
    if parsed.references:
        lines.append('references:')
        lines.extend(f'  - {_yaml_value(ref)}' for ref in parsed.references)
    else:
        lines.append('references: []')

    lines.append(f'thread: {_yaml_value(normalize_subject(parsed.subject))}')
    lines.append(f'thread_position: {member.position}')
    lines.append(f'thread_total: {member.total}')
    if member.position > 1:
        lines.append(f'new_paragraphs: {len(member.new_paragraphs)}')
    else:
        # У первого письма цепочки новизну сравнивать не с чем. Ноль здесь читался
        # бы как «ничего нового», хотя это «не вычислялось»: письмо тянет за собой
        # переписку, начавшуюся до папки (см. references).
        lines.append('new_paragraphs: null')

    if prepared.groups:
        # author остаётся пустым: цвет кодирует раунд правки, а не личность —
        # сопоставление с человеком делается отдельным проходом (слой 2).
        lines.append('inline_replies:')
        for group in prepared.groups:
            lines.append(f'  - id: {group.group_id}')
            lines.append(f'    color: {_yaml_value(group.color)}')
            lines.append(f'    fragments: {group.fragments}')
            lines.append(f'    chars: {group.chars}')
            lines.append(f'    author: ""')
            lines.append(f'    sample: {_yaml_value(group.sample)}')
    else:
        lines.append('inline_replies: []')
    if prepared.legend:
        text, author = prepared.legend
        lines.append(f'color_legend: {_yaml_value(text)}')
        # Легенда обычно взята из цитаты и принадлежит не отправителю письма —
        # без автора она приписывает вставки не тому человеку.
        lines.append(
            f'color_legend_author: {_yaml_value(author or parsed.headers.get("From"))}'
        )

    lines.append(f'attachments_total: {len(parsed.attachments)}')
    lines.append(f'attachments_inline: {inline}')
    lines.append(f'body_sha256: {_yaml_value(parsed.body_sha256)}')
    lines.append('---')
    return '\n'.join(lines)


def render_attachments_table(attachments: list[Attachment], link_prefix: str) -> str:
    if not attachments:
        return ''
    lines = [
        '',
        '## Вложения',
        '',
        '| Файл | Тип | Размер | Content-ID | В тексте |',
        '| --- | --- | --- | --- | --- |',
    ]
    for attachment in attachments:
        name = attachment.saved_name or attachment.filename
        link = f'[{name}]({link_prefix}/{name})'
        size = f'{attachment.size / 1024:.1f} КБ'
        cid = attachment.cid or '—'
        used = 'да' if attachment.referenced else 'нет'
        lines.append(f'| {link} | {attachment.content_type} | {size} | `{cid}` | {used} |')

    orphans = sum(1 for a in attachments if a.cid and not a.referenced)
    if orphans:
        lines.extend([
            '',
            f'> Вложений без ссылки в тексте: {orphans}. Outlook теряет привязку картинок '
            'при повторном цитировании, поэтому это, как правило, макеты из более ранних '
            'писем цепочки. Файлы сохранены и доступны по ссылкам выше.',
        ])
    return '\n'.join(lines)


def render_legend(prepared: Prepared) -> str:
    if not prepared.groups:
        return ''
    lines = ['', '## Inline-вставки', '']
    lines.append('| ID | Цвет | Фрагментов | Символов | Образец |')
    lines.append('| --- | --- | --- | --- | --- |')
    for group in prepared.groups:
        sample = group.sample.replace('|', '\\|')
        lines.append(
            f'| {group.group_id} | `{group.color}` | {group.fragments} | '
            f'{group.chars} | {sample} |'
        )
    lines.extend([
        '',
        '> Вставки найдены по цвету шрифта: автор отвечал внутрь цитаты, отличая свои '
        'реплики цветом. Цвет обозначает раунд правки, а не конкретного человека — '
        'сопоставить ID с автором нужно отдельно (поле `author` во frontmatter).',
    ])
    if prepared.legend:
        text, author = prepared.legend
        whose = author or prepared.parsed.headers.get('From') or 'отправитель'
        lines.append(f'>\n> Подсказка о цветах: «{text}» — её автор: {whose}')
    return '\n'.join(lines)


def render_new_section(member: ThreadMember) -> str:
    if member.position <= 1 or not member.new_paragraphs:
        return ''
    lines = [
        '',
        '## Новое в этом письме',
        '',
        f'Абзацев, которых не было в предыдущих письмах цепочки: '
        f'{len(member.new_paragraphs)} (письмо {member.position} из {member.total}).',
        '',
    ]
    lines.extend(f'{block}\n' for block in member.new_paragraphs)
    return '\n'.join(lines)


def mark_new_in_body(body: str, member: ThreadMember) -> str:
    """Проставляет метку NEW перед абзацами, которых не было раньше."""
    if member.position <= 1 or not member.new_paragraphs:
        return body
    new_keys = {paragraph_key(block) for block in member.new_paragraphs}
    new_keys.discard(None)
    if not new_keys:
        return body

    marked = []
    for block in split_paragraphs(body):
        if paragraph_key(block) in new_keys:
            if block.lstrip().startswith(BLOCK_STARTS):
                marked.append(f'{NEW_MARK}\n{block}')
            else:
                marked.append(f'{NEW_MARK} {block}')
        else:
            marked.append(block)
    return '\n\n'.join(marked)


def render(prepared: Prepared, member: ThreadMember) -> str:
    parsed = prepared.parsed
    body = mark_new_in_body(prepared.body, member)

    lines = [
        render_frontmatter(prepared, member),
        '',
        f'# {parsed.subject or parsed.source.stem}',
        '',
    ]
    for name in ('From', 'To', 'Cc'):
        if parsed.headers.get(name):
            lines.append(f'**{name}:** {parsed.headers[name]}  ')
    if parsed.date:
        lines.append(f'**Date:** {parsed.date.isoformat()}  ')
    if member.total > 1:
        lines.append(f'**Цепочка:** письмо {member.position} из {member.total}  ')
    if member.position <= 1:
        lines.append(
            '**Новизна:** не вычислялась — это первое письмо цепочки в папке, '
            'сравнивать не с чем. Читать письмо целиком.  '
        )
    lines.extend(['', '## Содержание', '', body])

    for section in (
        render_new_section(member),
        render_legend(prepared),
        render_attachments_table(parsed.attachments, prepared.link_prefix),
    ):
        if section:
            lines.append(section)
    return '\n'.join(lines).rstrip() + '\n'


def prepare_file(
    path: Path, out_dir: Path | None, attachments_root: Path | None, dry_run: bool
) -> Prepared:
    parsed = parse(path)
    target_dir = out_dir or path.parent
    if attachments_root is not None:
        attachments_dir = attachments_root / path.stem
    else:
        attachments_dir = target_dir / f'{path.stem}_attachments'
    # Ссылки внутри .md строим относительно самого .md — тогда пару
    # «письмо + вложения» можно перенести куда угодно, не переписывая пути.
    link_prefix = os.path.relpath(attachments_dir, target_dir).replace(os.sep, '/')

    mark_referenced(parsed)
    cid_map = save_attachments(parsed, attachments_dir, link_prefix, dry_run)
    if parsed.html:
        body, groups, legend = html_to_md.convert(parsed.html, cid_map)
    else:
        body, groups, legend = html_to_md.convert_plain(parsed.text), [], None

    return Prepared(
        path=path,
        parsed=parsed,
        body=body,
        groups=groups,
        legend=legend,
        cid_map=cid_map,
        attachments_dir=attachments_dir,
        link_prefix=link_prefix,
        out_path=target_dir / f'{path.stem}.md',
    )


def build_members(prepared_all: list[Prepared]) -> tuple[dict[str, ThreadMember], dict]:
    """Раскладывает письма по цепочкам и размечает новизну.

    Одно письмо может прийти двумя файлами (переслано дважды, выгружено из
    разных папок). Такие файлы делят один ThreadMember: иначе дубль занимает
    отдельную позицию в цепочке и, разобранный вторым, обнуляет новизну своего
    близнеца — все его абзацы к тому моменту уже в индексе.
    """
    members: dict[str, ThreadMember] = {}
    unique: dict[tuple, ThreadMember] = {}
    subjects: dict[str, str] = {}
    for item in prepared_all:
        identity = (item.parsed.message_id, item.parsed.body_sha256)
        member = unique.get(identity)
        if member is None:
            member = ThreadMember(
                key=str(item.path),
                message_id=item.parsed.message_id,
                date=item.parsed.date,
                paragraphs=split_paragraphs(item.body),
            )
            unique[identity] = member
            subjects[member.key] = item.parsed.subject
        members[str(item.path)] = member

    threads = build_threads(list(unique.values()), subjects)
    mark_new_content(threads)
    return members, threads


def collect_inputs(paths: list[str]) -> list[Path]:
    found: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            for suffix in SUPPORTED:
                found.extend(sorted(path.glob(f'*{suffix}')))
        elif path.suffix.lower() in SUPPORTED:
            found.append(path)
        else:
            print(f'пропуск (не письмо): {path}', file=sys.stderr)
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description='Конвертация писем .eml/.msg в Markdown')
    parser.add_argument('inputs', nargs='+', help='файлы .eml/.msg или директории с ними')
    parser.add_argument('--out-dir', type=Path, default=None, help='куда писать результат')
    parser.add_argument(
        '--attachments-dir',
        type=Path,
        default=None,
        help='общая папка вложений; для каждого письма создаётся подпапка по его имени',
    )
    parser.add_argument('--dry-run', action='store_true', help='не писать файлы, только отчёт')
    args = parser.parse_args()

    inputs = collect_inputs(args.inputs)
    if not inputs:
        print('нет входных писем', file=sys.stderr)
        return 1

    prepared_all: list[Prepared] = []
    failures: list[tuple[str, str]] = []
    for path in inputs:
        try:
            prepared_all.append(
                prepare_file(path, args.out_dir, args.attachments_dir, args.dry_run)
            )
        except Exception as error:  # noqa: BLE001 — отчёт важнее прерывания пачки
            print(f'ОШИБКА {path.name}: {error}', file=sys.stderr)
            failures.append((path.name, str(error)))

    members, threads = build_members(prepared_all)

    for item in prepared_all:
        member = members[str(item.path)]
        markdown = render(item, member)
        if not args.dry_run:
            item.out_path.parent.mkdir(parents=True, exist_ok=True)
            item.out_path.write_text(markdown, encoding='utf-8')

    print(f'\nОбработано: {len(prepared_all)}' + (' (dry-run)' if args.dry_run else ''))
    for item in prepared_all:
        member = members[str(item.path)]
        replies = f', вставок {len(item.groups)}' if item.groups else ''
        new = f', новых абзацев {len(member.new_paragraphs)}' if member.position > 1 else ''
        print(
            f'  ✓ {item.path.name} -> {item.out_path.name}: '
            f'вложений {len(item.parsed.attachments)}{replies}{new}'
        )
    for name, error in failures:
        print(f'  ✗ {name}: {error}')

    print('\nЦепочки:')
    for subject, chain in sorted(threads.items(), key=lambda kv: -len(kv[1])):
        if not subject:
            continue
        names = ' -> '.join(Path(m.key).name for m in chain)
        print(f'  [{len(chain)}] {subject[:60]}\n      {names}')

    by_body: dict[tuple, list[str]] = {}
    for item in prepared_all:
        key = (item.parsed.message_id, item.parsed.body_sha256)
        by_body.setdefault(key, []).append(item.path.name)
    duplicates = [names for names in by_body.values() if len(names) > 1]
    if duplicates:
        print('\nДубликаты (совпали message_id и тело):')
        for names in duplicates:
            print(f'  - {", ".join(names)}')

    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
