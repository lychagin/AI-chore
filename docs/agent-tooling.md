# Обвязка агента — одной страницей

Сводка того, что лежит в репозитории, для быстрого выбора инструмента. Подробности —
по ссылкам.

## Хуки

Исполняемые запускает Claude Code по событию; чек-листы агент читает сам —
**автоматически они не срабатывают.**

| Хук | Тип | Когда |
| --- | --- | --- |
| [`block-secret-dumps.sh`](../hooks/block-secret-dumps.sh) | исполняемый | `PreToolUse(Bash)` — блокирует команды, печатающие секреты |
| [`format-edited-file.sh`](../hooks/format-edited-file.sh) | исполняемый | `PostToolUse(Edit\|Write)` — prettier + eslint по правленому файлу |
| [`pre-task.md`](../hooks/pre-task.md) | чек-лист | Перед началом задачи |
| [`pre-commit.md`](../hooks/pre-commit.md) | чек-лист | Перед коммитом |

**Подробнее:** [hooks/README.md](../hooks/README.md)

## Агенты

| Когда нужно | Агент |
| --- | --- |
| Найти код по символу или логике | `code-searcher` |
| Проверить гипотезу запуском | `code-executor` |
| Разобрать причину, взвесить варианты | `code-thinker` |
| Перепроверить готовый вывод | `code-verifier` |
| Сверить со стандартом, сравнить подходы | `code-knowledge` |
| Ревью свежего кода | `code-architecture-reviewer` |
| Дизайн и UX | `ux-design-expert` |
| Техдокументация из ADR и комментариев | `tech-writer` |
| Привести memory bank в соответствие с кодом | `memory-bank-synchronizer` |
| Дельта-синхронизация memory bank | `context-diff-agent` |
| Узкий срез контекста под вопрос | `context-query-agent` |
| Найти устаревшее в memory bank | `stale-context-agent` |
| Разобрать документ требований | `decompose-agent` |
| Извлечь юз кейсы из требований | `use-case-extractor-agent` |

**Подробнее:** [agents/README.md](../agents/README.md)

## Команды

| Команда | Для чего |
| --- | --- |
| `/decompose`, `/new-requirement`, `/new-usecase`, `/generate-diagrams` | Работа с требованиями |
| `/mr` | Описание и создание merge request |
| `/context-query` | Узкий срез memory bank под вопрос |
| `/context-diff` | Ежедневная синхронизация по дельте |
| `/update-memory-bank` | Полное обновление |
| `/stale-context-check` | Проверка актуальности |
| `/cleanup-context` | Архивация накопившегося |
| `/rebuild-granular-from-archive` | Восстановление структуры из архива |

**Подробнее:** [commands/README.md](../commands/README.md)

## Скиллы

`pre-mr`, `commit`, `get-comment`, `resolve-remarks`, `reply-comment`, `mine-patterns`,
`review-commits`, `handoff`.

**Подробнее:** [skills/README.md](../skills/README.md)

## Workflows memory bank

Delta Sync, Feature Wrap, Hotfix, Hygiene, JIT Context, New Feature Rehydrate.

**Подробнее:** [memory-bank-workflows/README.md](memory-bank-workflows/README.md)
