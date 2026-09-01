# MR Template Tooling

Единый шаблон описания Merge Request + AI-команда, которая заполняет его за вас.
Цель — чтобы **все** MR описывались одинаково и информативно, а рутину (тип задачи,
ссылки, чек-лист) делала машина, а не человек.

## Зачем это нужно

- **Ревьюеру** — понятный, единообразный MR: суть, как проверено, что затронуто.
- **Авторам** — не надо вспоминать структуру: тип задачи (баг / задача фичи / отдельная
  задача) и набор полей подбираются автоматически по номеру задачи из OpenProject.
- **Никакой лишней ручной работы** — номер задачи, ссылки, затронутые сервисы,
  backend/frontend и условные пункты чек-листа (OpenAPI → `npm run build`, DGraph →
  миграция, скриншоты для фронта) проставляет скрипт. Человек/модель пишут только прозу.

Два способа заполнить один и тот же шаблон:

1. **Web GitLab** — при создании MR выберите шаблон в выпадающем списке
   «Choose a template» (`bug` / `feature-task` / `task`). Получите готовый скелет.
2. **AI-команда** — `/mr` в Claude/OpenCode или «подготовь MR» в Cursor: скелет
   заполняется автоматически, MR при желании создаётся через GitLab API.

## Установка и настройка

Токены берутся из `.envrc` (gitignored, экспортируется через `direnv`).

1. Скопируйте недостающие строки из `.envrc.example` в корне репозитория в свой `.envrc`.
   GitLab-переменные обычно уже есть; добавьте OpenProject:

   ```bash
   export OPENPROJECTTOKEN=<ваш personal access token>
   export OPENPROJECT_URL=https://openproject.example.com
   export OPENPROJECT_PROJECT=<идентификатор проекта>
   ```

   Personal Access Token: OpenProject → Account settings → Access tokens.

   OpenProject стоит за корпоративным CA, поэтому Node нужно доверять CA-бандлу для `fetch`.
   Добавьте в `.envrc`:

   ```bash
   export NODE_EXTRA_CA_CERTS="$PWD/tools/mr-template/openproject-ca.pem"
   ```

   Бандл закоммичен в репо. Worktree-нюанс: `NODE_EXTRA_CA_CERTS` должен быть в окружении
   ДО запуска node — продублируйте строку в `.envrc` worktree, если работаете из него
   (движок не может выставить её сам после старта процесса).

2. `direnv allow` (один раз после правки `.envrc`).
3. Проверка: `node tools/mr-template/index.mjs context` — печатает JSON контекста ветки.

> **Worktree:** если запускаете из git-worktree без своего `.envrc`, движок сам найдёт
> `.envrc` основного клона репозитория. Можно также продублировать `.envrc` в worktree.

Зависимостей нет — только Node.js (встроенный `fetch`). GitLab API дёргается напрямую,
`glab` не нужен.

## Использование

### Claude Code

```
/mr               # сгенерировать описание, записать в файл
/mr --push        # ещё и создать/обновить MR в GitLab
/mr --target release/x   # другая целевая ветка (по умолчанию develop)
```

### OpenCode

```
/mr [--push] [--target <branch>]
```

### Cursor

Slash-команд нет — напишите агенту «подготовь MR» (или «подготовь MR и запушь»).
Сценарий тот же.

### Web GitLab

Создавая MR в браузере, выберите шаблон в списке «Choose a template». Это статичный
скелет со всеми пунктами — заполните вручную.

## Как это работает

```
context   → детерминированный JSON: тип задачи (OpenProject), ссылки, чек-лист (из git diff),
            commits, diffstat, blameHints, testFilesInDiff
skeleton  → адаптивный markdown-скелет: авто-поля подставлены, неприменимые пункты чек-листа
            вырезаны, проза оставлена как <!-- AI: ... --> плейсхолдеры
publish   → пишет итог в файл (.swap/.../mr-description/<branch>.md) и при --push создаёт/обновляет
            MR через GitLab API; при сбое API — остаётся файл + инструкция создать MR вручную
```

Тип задачи определяется так: OpenProject `Bug` → `bug`; не-Bug с родителем → `feature-task`;
иначе → `task`. Нет номера в имени ветки → команда спросит; не ввели — операция прерывается.

## CLI движка

```bash
node tools/mr-template/index.mjs context [--target <b>] [--task <N>]
node tools/mr-template/index.mjs skeleton --task <N> [--target <b>]
node tools/mr-template/index.mjs publish --file <md> --title "<title>" [--push] [--target <b>]
node tools/mr-template/index.mjs gen-templates   # перегенерировать .gitlab/merge_request_templates/*
```

## Тесты

```bash
npm run mr:test
```

Конвенция `.scripts`: `node:assert` + `*.test.mjs`, запуск напрямую через `node`.

## Состав

| Путь                                                         | Назначение                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `tools/mr-template/`                                      | движок (config, git-context, openproject, sections, render, context, publish, gitlab, index) + тесты |
| `.gitlab/merge_request_templates/{task,feature-task,bug}.md` | native-шаблоны для web (генерируются `gen-templates`)                                                |
| `.claude/commands/mr.md`                                     | команда `/mr` для Claude Code                                                                        |
| `.cursor/skills/mr/SKILL.md`                                 | скилл для Cursor                                                                                     |
| `.opencode/command/mr.md`                                    | команда `/mr` для OpenCode                                                                           |
| `.envrc.example`                                             | пример переменных окружения                                                                          |

---

## Как приспособить к своему проекту

1. **Трекер.** `openproject.mjs` обращается к REST API v3 OpenProject: тип задачи,
   родитель, ссылка на тикет. Для другого трекера переписывается этот файл — остальной
   конвейер (`context` → `skeleton` → `publish`) не меняется.
2. **Хостинг репозитория.** `gitlab.mjs` создаёт и обновляет MR через GitLab API.
   Под GitHub меняется он один.
3. **Разделы шаблона.** `sections.mjs` задаёт состав описания и правила, по которым
   пункт чек-листа считается применимым (например, «есть ли в diff изменения
   спецификации»). Это главный файл для подгонки под свой процесс ревью.
4. **Каталог черновиков.** `publish.mjs` пишет итог в `.swap/mr-description/<branch>.md`.
   Поменяй путь, если у тебя другой каталог для файлов вне гита.
5. **Формат заголовка MR.** Если CI проверяет заголовок (commitlint при squash), сверь
   генерацию в `render.mjs` со своими правилами: при squash именно заголовок MR
   становится итоговым сообщением коммита.

## Проверка после переноса

```bash
node --test tools/mr-template
```

8 тестовых файлов покрывают разбор git-контекста, рендер шаблона, публикацию и клиенты
трекера и GitLab. Прогоняются без сети — внешние вызовы замоканы.
