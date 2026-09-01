# Memory Bank System

Structured memory bank с специализированными файлами контекста. Проверяй перед началом работы.

## Структура (authoritative for day-to-day work)

- `memory_bank/decisions/**` — ADRs и trade-offs
- `memory_bank/patterns/**` — паттерны и conventions (43 файла)
- `memory_bank/architecture/**` — топология модулей/сервисов (11 файлов)
- `memory_bank/troubleshooting/**` — проблемы и решения (8 файлов)
- `memory_bank/checklists/**` — пошаговые руководства (3 файла)
- `memory_bank/anti-patterns/**` — критические ошибки (3 файла)
- `memory_bank/stash/**` — scratch pad (читай только по ссылке)
- `.docs/development/quick-reference.md` — TOP-10 правил
- `.docs/development/lessons-learned.md` — уроки из code review

> Используй `/context-query` с path scopes для загрузки только нужных секций.

## Индекс содержимого

Индекс — это оглавление memory bank одной страницей: агент читает его целиком и по нему
решает, какой файл грузить. Держи его в актуальном состоянии, иначе он теряет смысл.

Ниже — как это выглядит на [проекте-примере OrderShop](../examples/example-project.md).
Замени содержимое на своё; сохраняй форму «категория (сколько файлов): список тем».

**Architecture** (6): HTTP-слой (Fastify), Схема БД (PostgreSQL/Prisma), Слой репозиториев,
Очередь задач, Аутентификация и роли, Фронтенд заказов

**Decisions** (5 ADRs): Contract-First через OpenAPI, PostgreSQL вместо документной БД,
Монорепозиторий, Мягкое удаление вместо физического, Идемпотентность создания заказа

**Patterns** (12): Универсальный CRUD, Построитель запросов, Обработка ошибок,
Права на уровне поля, Кэширование выборок, Ссылки на сущности в OpenAPI,
Создание схемы OpenAPI, Словари, Мягкое удаление, и др.

**Troubleshooting** (5): Отвал соединения с БД, Permission denied, Инвалидация кэша,
Утечки памяти в тестах, Расхождение сгенерированных валидаторов с кодом

## Backup

Копировать `memory_bank/{decisions,patterns,architecture,troubleshooting}/` и `.claude/` settings → `.claude/memory_backup`.
Перезаписывать существующие. Исключать `memory_bank/archive/**`.

## Archive

`memory_bank/archive/` — историческая документация. **Read-only.** Не загружать для рутинных задач.
