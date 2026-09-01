#!/usr/bin/env python3
"""Тесты конвертера на реальных письмах.

Фикстуры — реальные письма (каталог задаётся через EML_FIXTURES_DIR): без них тесты
не запустить, поэтому при отсутствии каталога прогон пропускается, а не падает.

Запуск:
    .venv/bin/python test_convert.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import convert  # noqa: E402
from thread import ThreadMember  # noqa: E402

# Каталог с исходными .eml. Свой корпус писем указывается через EML_FIXTURES_DIR;
# без него тесты помечаются как пропущенные (см. конец файла).
ORIG = Path(os.environ.get('EML_FIXTURES_DIR', Path(__file__).parent / 'fixtures' / 'orig'))

# Имена файлов ниже — из корпуса, на котором писались тесты. Под свой корпус
# подставь свои: тесты проверяют разбор, а не конкретные письма.
#
# Что должно быть в каждой фикстуре:
#   THREAD_OF_THREE — тред из трёх писем одной темы, где в третьем есть короткий
#                     абзац-ответ и абзац, дословно повторяющий текст второго письма
#   QUESTIONS       — четыре файла, из которых два — дубли одного письма
#                     (совпадают message_id и тело)
#   LEGEND_RU_*     — письмо, где легенда про цвет вставок написана участником треда
#                     в цитате, а не отправителем; шапка цитаты на русском
#   LEGEND_EN_*     — то же самое, но шапка цитаты на английском (From:/Sent:)
THREAD_OF_THREE = [
    '2026-07-24-thread.eml',
    '2026-08-03-thread.eml',
    '2026-08-04-thread.eml',
]
THREAD_LAST = THREAD_OF_THREE[-1]

LEGEND_RU_EML = '2026-07-29-legend-ru.eml'
LEGEND_RU_AUTHOR = 'Петров'
LEGEND_EN_EML = '2026-07-29-legend-en.eml'
LEGEND_EN_AUTHOR = 'Ivanova'

QUESTIONS = [
    '2026-03-03-questions.eml',
    '2026-03-06-questions-1.eml',
    '2026-03-06-questions-2.eml',
    '2026-04-27-questions.eml',
]


def run_chain(names: list[str]) -> dict[str, tuple[str, ThreadMember]]:
    """Прогоняет письма через пайплайн так же, как main(), но без записи на диск."""
    prepared = [convert.prepare_file(ORIG / name, None, None, dry_run=True) for name in names]
    members, _ = convert.build_members(prepared)
    return {
        item.path.name: (convert.render(item, members[str(item.path)]), members[str(item.path)])
        for item in prepared
    }


# --- тесты -----------------------------------------------------------------

def test_duplicate_does_not_take_own_position():
    """Два файла с одним message_id и телом — одно письмо, а не две позиции цепочки."""
    result = run_chain(QUESTIONS)
    twin_a = result['2026-03-06-questions-1.eml'][1]
    twin_b = result['2026-03-06-questions-2.eml'][1]
    last = result['2026-04-27-questions.eml'][1]
    assert twin_a.total == 3, f'в цепочке должно быть 3 письма, а не {twin_a.total}'
    assert twin_a.position == twin_b.position, (
        f'дубль занял отдельную позицию: {twin_a.position} и {twin_b.position}'
    )
    assert last.position == 3, f'последнее письмо должно быть 3-м, а не {last.position}'


def test_duplicate_does_not_swallow_novelty():
    """Дубль не должен «съедать» новизну своего близнеца."""
    result = run_chain(QUESTIONS)
    twin_b = result['2026-03-06-questions-2.eml'][1]
    assert twin_b.new_paragraphs, (
        'у дубля новизна обнулена — его близнец уже положил абзацы в индекс'
    )


def test_legend_carries_its_author():
    """Легенда из цитаты приписывается автору цитаты, а не отправителю письма."""
    prepared = convert.prepare_file(
        ORIG / LEGEND_RU_EML, None, None, dry_run=True
    )
    assert prepared.legend, 'легенда «Ответы в тексте синим» потеряна'
    text, author = prepared.legend
    assert 'син' in text.lower(), f'не та фраза: {text!r}'
    assert author and LEGEND_RU_AUTHOR in author, (
        f'легенда приписана отправителю письма, а писал её автор цитаты: {author!r}'
    )


def test_legend_author_survives_english_headers():
    """Тот же разбор на англоязычной шапке цитаты (From:/Sent:)."""
    prepared = convert.prepare_file(
        ORIG / LEGEND_EN_EML, None, None, dry_run=True
    )
    assert prepared.legend, 'легенда про оранжевый шрифт потеряна'
    text, author = prepared.legend
    assert 'оранжев' in text.lower(), f'не та фраза: {text!r}'
    # Легенда написана не отправителем последнего письма, а участником треда ниже
    # по цитате — проверяем, что авторство не съехало на отправителя.
    assert author and LEGEND_EN_AUTHOR in author, (
        f'легенда приписана отправителю письма, а писал её другой участник: {author!r}'
    )


def test_short_paragraph_is_marked_new():
    """Короткий абзац — тоже факт: «Про длительность – ок» должен получить метку."""
    markdown = run_chain(THREAD_OF_THREE)[THREAD_LAST][0]
    assert '**[NEW]** Про длительность – ок' in markdown, (
        'короткий ответ заказчика не помечен новым (MIN_PARAGRAPH_CHARS его отбрасывает)'
    )


def test_repacked_block_is_not_new():
    """Текст из прошлого письма не становится новым из-за иных границ абзаца."""
    markdown = run_chain(THREAD_OF_THREE)[THREAD_LAST][0]
    assert '**[NEW]** Хочу подсветить несколько моментов' not in markdown, (
        'абзац из письма 2 помечен новым в письме 3: хеш блока не пережил перепаковку'
    )


def test_first_letter_novelty_is_undetermined():
    """У первого письма цепочки новизна не вычислялась — это не «ноль новых»."""
    result = run_chain(QUESTIONS)
    markdown = result['2026-03-03-questions.eml'][0]
    assert 'new_paragraphs: 0' not in markdown, (
        'первое письмо цепочки объявлено «0 новых абзацев», хотя сравнивать было не с чем'
    )


TESTS = [
    test_duplicate_does_not_take_own_position,
    test_duplicate_does_not_swallow_novelty,
    test_legend_carries_its_author,
    test_legend_author_survives_english_headers,
    test_short_paragraph_is_marked_new,
    test_repacked_block_is_not_new,
    test_first_letter_novelty_is_undetermined,
]


def main() -> int:
    if not ORIG.is_dir():
        print(f'пропуск: нет фикстур {ORIG} (каталог в .gitignore)')
        return 0
    failed = 0
    for test in TESTS:
        try:
            test()
        except AssertionError as error:
            failed += 1
            print(f'  ✗ {test.__name__}\n      {error}')
        except Exception as error:  # noqa: BLE001 — отчёт по всей пачке важнее
            failed += 1
            print(f'  ✗ {test.__name__}\n      ОШИБКА {type(error).__name__}: {error}')
        else:
            print(f'  ✓ {test.__name__}')
    print(f'\nпройдено {len(TESTS) - failed} из {len(TESTS)}')
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
