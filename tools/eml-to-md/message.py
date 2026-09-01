"""Разбор писем .eml и .msg в единую структуру.

Скрывает различия форматов: наружу отдаётся ParsedMessage с заголовками,
телом (html/text) и списком вложений с нормализованными Content-ID.
"""

from __future__ import annotations

import email
import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import policy
from email.header import decode_header
from email.utils import parsedate_to_datetime
from pathlib import Path

# Заголовки, которые попадают во frontmatter как есть.
ADDRESS_HEADERS = ('From', 'To', 'Cc')


@dataclass
class Attachment:
    """Одна часть письма: inline-картинка или приложенный файл."""

    filename: str
    content_type: str
    data: bytes
    cid: str | None = None
    is_inline: bool = False
    saved_name: str | None = None
    referenced: bool = False

    @property
    def size(self) -> int:
        return len(self.data)


@dataclass
class ParsedMessage:
    source: Path
    subject: str = ''
    date: datetime | None = None
    headers: dict[str, str] = field(default_factory=dict)
    message_id: str | None = None
    in_reply_to: str | None = None
    references: list[str] = field(default_factory=list)
    html: str | None = None
    text: str | None = None
    attachments: list[Attachment] = field(default_factory=list)

    @property
    def body_sha256(self) -> str:
        body = self.html or self.text or ''
        return hashlib.sha256(body.encode('utf-8', 'replace')).hexdigest()


def decode_hdr(raw: str | None) -> str:
    """Декодирует RFC 2047 заголовок в читаемую строку."""
    if not raw:
        return ''
    parts = []
    for chunk, charset in decode_header(raw):
        if isinstance(chunk, bytes):
            parts.append(chunk.decode(charset or 'utf-8', 'replace'))
        else:
            parts.append(chunk)
    # Outlook кладёт ведущие табы и переносы в Subject — схлопываем пробелы.
    return re.sub(r'\s+', ' ', ''.join(parts)).strip()


def _normalize_cid(raw: str | None) -> str | None:
    """<image001.png@01DD.ABC> -> image001.png@01DD.ABC"""
    if not raw:
        return None
    return raw.strip().strip('<>').strip()


def _split_references(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [ref for ref in re.split(r'\s+', raw.strip()) if ref]


def _safe_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if parsed is not None and parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _fallback_name(cid: str | None, content_type: str, index: int) -> str:
    """Имя для части без filename: из cid, иначе по индексу."""
    if cid:
        candidate = cid.split('@')[0]
        if candidate:
            return candidate
    ext = content_type.split('/')[-1].replace('jpeg', 'jpg')
    return f'part{index:03d}.{ext}'


def parse_eml(path: Path) -> ParsedMessage:
    with path.open('rb') as handle:
        raw = email.message_from_binary_file(handle, policy=policy.default)

    parsed = ParsedMessage(source=path)
    parsed.subject = decode_hdr(raw.get('Subject'))
    parsed.date = _safe_date(raw.get('Date'))
    parsed.message_id = _normalize_cid(raw.get('Message-ID'))
    parsed.in_reply_to = _normalize_cid(raw.get('In-Reply-To'))
    parsed.references = _split_references(raw.get('References'))
    for name in ADDRESS_HEADERS:
        value = decode_hdr(raw.get(name))
        if value:
            parsed.headers[name] = value

    for index, part in enumerate(raw.walk()):
        if part.get_content_maintype() == 'multipart':
            continue
        content_type = part.get_content_type()
        disposition = (part.get_content_disposition() or '')
        filename = part.get_filename()
        cid = _normalize_cid(part.get('Content-ID'))

        # Тело письма: первая text/plain и text/html без имени файла.
        if content_type == 'text/plain' and not filename and disposition != 'attachment':
            if parsed.text is None:
                parsed.text = part.get_content()
            continue
        if content_type == 'text/html' and not filename and disposition != 'attachment':
            if parsed.html is None:
                parsed.html = part.get_content()
            continue

        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        parsed.attachments.append(
            Attachment(
                filename=filename or _fallback_name(cid, content_type, index),
                content_type=content_type,
                data=payload,
                cid=cid,
                is_inline=disposition == 'inline' or bool(cid),
            )
        )
    return parsed


def parse_msg(path: Path) -> ParsedMessage:
    import extract_msg
    from extract_msg.enums import ErrorBehavior

    # Часть писем Outlook несёт битый encapsulated RTF: без этих флагов
    # extract_msg падает вместо того, чтобы отдать HTML-тело.
    tolerant = (
        ErrorBehavior.RTFDE_MALFORMED
        | ErrorBehavior.RTFDE_UNKNOWN_ERROR
        | ErrorBehavior.ATTACH_BROKEN
        | ErrorBehavior.STANDARDS_VIOLATION
    )

    parsed = ParsedMessage(source=path)
    with extract_msg.openMsg(str(path), errorBehavior=tolerant) as msg:
        # У .msg есть транспортные заголовки — берём их, чтобы разбор совпадал с .eml.
        raw_headers = msg.header
        if raw_headers is not None:
            parsed.subject = decode_hdr(raw_headers.get('Subject')) or (msg.subject or '').strip()
            parsed.date = _safe_date(raw_headers.get('Date'))
            parsed.message_id = _normalize_cid(raw_headers.get('Message-ID'))
            parsed.in_reply_to = _normalize_cid(raw_headers.get('In-Reply-To'))
            parsed.references = _split_references(raw_headers.get('References'))
            for name in ADDRESS_HEADERS:
                value = decode_hdr(raw_headers.get(name))
                if value:
                    parsed.headers[name] = value

        if not parsed.subject:
            parsed.subject = re.sub(r'\s+', ' ', (msg.subject or '')).strip()
        if parsed.date is None and msg.date is not None:
            parsed.date = msg.date if msg.date.tzinfo else msg.date.replace(tzinfo=timezone.utc)
        if 'From' not in parsed.headers and msg.sender:
            parsed.headers['From'] = decode_hdr(msg.sender)
        if 'To' not in parsed.headers and msg.to:
            parsed.headers['To'] = decode_hdr(msg.to)
        if 'Cc' not in parsed.headers and msg.cc:
            parsed.headers['Cc'] = decode_hdr(msg.cc)

        html = msg.htmlBody
        if isinstance(html, bytes):
            html = html.decode('utf-8', 'replace')
        parsed.html = html
        parsed.text = msg.body

        for index, att in enumerate(msg.attachments):
            data = att.data
            if not isinstance(data, bytes):
                continue  # вложенное письмо (.msg внутри .msg) — пропускаем
            cid = _normalize_cid(getattr(att, 'cid', None))
            name = att.longFilename or att.shortFilename
            content_type = getattr(att, 'mimetype', None) or 'application/octet-stream'
            parsed.attachments.append(
                Attachment(
                    filename=name or _fallback_name(cid, content_type, index),
                    content_type=content_type,
                    data=data,
                    cid=cid,
                    is_inline=bool(cid),
                )
            )
    return parsed


def parse(path: Path) -> ParsedMessage:
    suffix = path.suffix.lower()
    if suffix == '.eml':
        return parse_eml(path)
    if suffix == '.msg':
        return parse_msg(path)
    raise ValueError(f'Неподдерживаемое расширение: {path}')
