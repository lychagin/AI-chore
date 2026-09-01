# Review Collector

Инструмент для сбора ревью-комментариев из GitLab Merge Requests в плоский JSONL формат — для последующего анализа паттернов ревью.

## Зачем

Цикл работы выглядит так:

```
GitLab API
    ↓
[Review Collector]  →  JSONL файлы с комментариями
    ↓
[Pattern Mining]    →  правила ревью (планируется)
    ↓
[Reviewer Agent]    ←  diff нового MR
    ↓
structured review report
```

Review Collector — первая ступень: он скачивает все человеческие комментарии из MR за заданный период и сохраняет их в файлы для дальнейшей обработки.

## Требования

- Node.js 20+
- Доступ к GitLab (токен с правом `read_api`)
- Сеть до GitLab сервера (VPN если нужно)

Внешних npm-зависимостей нет — используется только стандартная библиотека Node.js.

## Установка

```bash
git clone git@github.com:lychagin/review-collector.git
cd review-collector
cp .env.example .env
```

Заполни `.env`:

```env
GITLAB_TOKEN=your_gitlab_token_here
GITLAB_URL=https://your-gitlab.example.com/api/v4
DEFAULT_PROJECT_ID=your-group/your-project
```

Токен создаётся в GitLab: **Settings → Access Tokens → read_api**.

## Установка в другой проект

Скопировать каталог целиком и создать рабочие директории:

```bash
cp -r tools/review-collector /path/to/your-project/review-collector
mkdir -p /path/to/your-project/review-collector/{patterns,review}
```

Скиллы, которые с ним работают, ставятся отдельно — они лежат в
[`skills/mine-patterns`](../../skills/mine-patterns/SKILL.md) и
[`skills/review-commits`](../../skills/review-commits/SKILL.md) и раскладываются
общим `install.sh` этого репозитория.

После установки скопируй и заполни credentials:

```bash
cp review-collector/.env.example review-collector/.env
# Редактируй .env: укажи GITLAB_TOKEN и GITLAB_URL
```

Затем используй скиллы Claude Code в своём проекте:

- `/mine-patterns` — извлечение и анализ паттернов ревью из MR
- `/review-commits` — ревью своих коммитов по паттернам

## Запуск

### Сбор комментариев

```bash
# За последние 3 месяца (по умолчанию)
node collect-mr-comments.mjs

# За конкретный период
node collect-mr-comments.mjs --period 6m
node collect-mr-comments.mjs --period 30d --verbose
node collect-mr-comments.mjs --from 2026-01-01 --to 2026-03-31

# Другой проект
node collect-mr-comments.mjs --period 3m --project other-group/other-repo

# Только merged или только closed
node collect-mr-comments.mjs --states merged
node collect-mr-comments.mjs --states merged,closed

# Указать путь к файлу вручную
node collect-mr-comments.mjs --output /tmp/my-comments.jsonl

# Повторный сбор за тот же период (игнорировать предупреждение)
node collect-mr-comments.mjs --period 3m --force
```

Результат сохраняется в `pending/`:

```
review/raw/
  pending/
    mr-notes-2026-04-12T10-30-00.jsonl      ← данные
    mr-notes-2026-04-12T10-30-00.meta.json  ← метаданные (период, статистика)
```

По умолчанию `output-root` — папка `review/raw/` в директории проекта (создаётся автоматически), или задаётся через `--output`.

### Анализ паттернов

После сбора запусти Pattern Mining — он прочитает файлы из `review/raw/pending/` и автоматически
переместит их в `review/raw/processed/` после успешной обработки:

```
/mine-patterns
```

Либо запусти препроцессор напрямую (без LLM-анализа):

```bash
node preprocess-comments.mjs
# Читает review/raw/pending/, перемещает в review/raw/processed/
# Записывает patterns/threads.jsonl
```

Старые файлы из `processed/` можно архивировать:

```bash
# Показать что будет архивировано (ничего не трогает)
node collect-mr-comments.mjs archive --older-than 30d --dry-run

# Переместить в archive/YYYY-MM/
node collect-mr-comments.mjs archive --older-than 30d
node collect-mr-comments.mjs archive --older-than 60d
```

### Справка

```bash
node collect-mr-comments.mjs --help
```

## Формат выходных данных

JSONL — одна строка на комментарий. Каждая запись содержит:

| Поле                               | Описание                                |
| ---------------------------------- | --------------------------------------- |
| `mr_iid`, `mr_title`, `mr_state`   | Данные MR                               |
| `mr_author_username`, `mr_labels`  | Автор и метки MR                        |
| `discussion_id`, `discussion_kind` | ID треда, тип: `diff` или `overview`    |
| `discussion_resolved`              | Решён ли тред                           |
| `note_id`, `note_body`             | ID и текст комментария                  |
| `note_author_username`             | Автор комментария                       |
| `is_root_note`, `parent_note_id`   | Позиция в треде                         |
| `file_path`, `new_line`            | Файл и строка (для inline комментариев) |
| `has_suggestions`                  | Есть ли `suggestion` блок               |
| `exported_at`                      | Время экспорта                          |

Пример строки:

```json
{"schema_version":"1.0","mr_iid":1828,"mr_title":"feat: add timeout","discussion_kind":"diff","note_body":"Нужен timeout, иначе при недоступности сервиса запросы зависнут","file_path":"src/client.ts","new_line":57,"is_root_note":true,...}
```

## Тесты

Тестов нет. Функции разбора комментариев чистые и покрываются легко — если будешь
дорабатывать препроцессор под свой формат ревью, начни с них.

## Структура проекта

```
.
├── collect-mr-comments.mjs   # CLI (Extraction Tool)
├── mr-comments-collector.mjs # Ядро: pipeline + чистые функции
├── gitlab-client.mjs         # HTTP клиент GitLab API
├── get-diff.mjs              # Выгрузка diff для контекста комментария
├── preprocess-comments.mjs   # Pattern Mining: препроцессор
├── .env.example              # Шаблон конфигурации
├── HOW-TO.md                 # Пошаговое руководство
└── patterns/                 # Выход Pattern Mining (создаётся при первом запуске)
    ├── review-patterns.json  # Финальные паттерны (source of truth)
    ├── review-patterns.md    # Человекочитаемый view
    ├── mining-state.json     # Состояние: обработанные файлы + raw паттерны
    └── threads.jsonl         # Промежуточный артефакт препроцессора
```

Каталог `patterns/` в репозиторий не кладётся: это накопленные правила конкретной
команды, а не часть инструмента.

## Как приспособить к своему проекту

1. **Хостинг репозитория.** `gitlab-client.mjs` написан под GitLab API v4 и его модель
   дискуссий: у комментария есть `discussion_id`, тред резолвится отдельным вызовом.
   Под GitHub PR меняется только этот файл — форма выходного JSONL остаётся.
2. **Фильтрация ботов.** `BOT_USERNAME_PATTERNS` в `.env` — впиши имена своих CI-ботов,
   иначе их сообщения попадут в корпус и исказят паттерны.
3. **Объём корпуса.** На истории в десяток MR анализ даст шум. Ощутимый результат
   начинается с нескольких сотен комментариев — на новом проекте инструмент
   бесполезен, вернись к нему через полгода.

## Фильтрация

Автоматически отфильтровываются:

- System notes (GitLab служебные сообщения)
- Боты (по умолчанию: `*-bot`, `*_bot`, `ghost`)
- Пустые комментарии

Список ботов можно переопределить в `.env`:

```env
BOT_USERNAME_PATTERNS=*-bot,*_bot,ghost,ci-user
```
