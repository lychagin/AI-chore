# MCP GitLab

MCP сервер для GitLab: ремарки Merge Request, создание и обновление MR, issues, пайплайны.  
Транспорт: **stdio** (запуск через `command` + `args` в конфиге клиента).  
Платформы: Linux, macOS, Windows.

> Сервер назывался `get-comments` и покрывал только ремарки. С августа 2026 — `gitlab`,
> каталог `mcp-gitlab`, инструменты `mcp__gitlab__*`.

## Особенности

- Получение и фильтрация комментариев из MR (resolved/system скипаются)
- Добавление общих и diff-комментариев к MR, ответы на нити, resolve discussion
- Получение мета-информации о MR (SHA для diff комментариев) и списка изменённых файлов
- Создание MR **без дублей**: если по ветке уже есть открытый MR, возвращается он
- Issues проекта: чтение, поиск, создание, обновление
- Статус последнего пайплайна по MR или ветке со списком упавших job'ов
- Большие ответы сохраняются в temp-файл — в чат передаётся только компактное summary (нет фризов UI)
- Сетевые ошибки классифицированы; для мутаций и 5xx в тексте ошибки сказано, что
  состояние на сервере неизвестно — повторять вслепую нельзя

## Установка

```bash
cd .scripts/mcp/mcp-servers/mcp-gitlab
npm install
```

## Конфигурация

### Переменные окружения

| Переменная           | По умолчанию                        | Описание                                             |
| -------------------- | ----------------------------------- | ---------------------------------------------------- |
| `GITLAB_TOKEN`       | —                                   | GitLab Personal Access Token (обязательный)          |
| `GITLAB_URL`         | `https://gitlab.example.com/api/v4` | Base URL GitLab API                                  |
| `DEFAULT_PROJECT_ID` | `namespace/project`        | Проект по умолчанию (namespace/name или числовой ID) |
| `GITLAB_TIMEOUT_MS`  | `10000`                             | Таймаут запроса к GitLab API, мс                     |

#### Источники токена (приоритет по убыванию)

1. `GITLAB_TOKEN` в окружении процесса (CI, shell export)
2. `.env` файл рядом с `index.js`
3. `~/.cursor/gitlab-token` — файл с одной строкой токена
4. `.envrc` в корне репозитория — direnv до MCP-процесса не доходит, поэтому сервер
   читает файл сам; `$PWD` в значениях раскрывается по каталогу самого `.envrc`

### Файл `.env`

```bash
GITLAB_TOKEN=glpat-ваш_токен
GITLAB_URL=https://gitlab.example.com/api/v4
DEFAULT_PROJECT_ID=namespace/project
GITLAB_TIMEOUT_MS=10000
```

### Отладочные переменные окружения

| Переменная           | По умолчанию          | Описание                                             |
| -------------------- | --------------------- | ---------------------------------------------------- |
| `MCP_DEBUG`          | `false`               | Включить детальное логирование (в stderr и файл)     |
| `MCP_DEBUG_SLOW_MS`  | `1000`                | Порог "медленного" вызова в мс — логировать отдельно |
| `MCP_DEBUG_LOG_FILE` | `/tmp/gitlab-mcp.log` | Путь к файлу лога (дополняется, не перезаписывается) |

#### Пример конфига с дебагом

```json
{
  "gitlab": {
    "command": "node",
    "args": [".cursor/mcp-gitlab-launcher.mjs"],
    "env": {
      "MCP_DEBUG": "true",
      "MCP_DEBUG_SLOW_MS": "200",
      "MCP_DEBUG_LOG_FILE": "/tmp/gitlab-mcp.log",
      "GITLAB_TIMEOUT_MS": "10000"
    }
  }
}
```

Просмотр лога:

```bash
tail -f /tmp/gitlab-mcp.log
```

## Интеграция с Cursor

Используется launcher-скрипт `.cursor/mcp-gitlab-launcher.mjs`, который вычисляет путь к `index.js` от своего расположения — это нужно, потому что Cursor Agent CLI не подставляет `${workspaceFolder}` в `args`.

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": [".cursor/mcp-gitlab-launcher.mjs"],
      "env": {
        "MCP_DEBUG_SLOW_MS": "200"
      }
    }
  }
}
```

## Интеграция с Claude Code

Два варианта — выбери подходящий.

### Вариант A: проектный `.mcp.json` (рекомендуется)

Файл `.mcp.json` в корне репозитория. Claude Code запускает его из корня проекта, поэтому **относительные пути работают**:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": [".scripts/mcp/mcp-servers/mcp-gitlab/index.js"]
    }
  }
}
```

### Вариант B: глобальный `~/.claude/settings.json`

Глобальный конфиг не привязан к проекту, поэтому нужен **абсолютный путь**:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["/абсолютный/путь/к/репо/.scripts/mcp/mcp-servers/mcp-gitlab/index.js"]
    }
  }
}
```

## Интеграция с Claude Desktop

Конфиг не привязан к проекту → только **абсолютный путь**.

`~/.config/Claude/claude_desktop_config.json` (Linux/macOS) или `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["/абсолютный/путь/к/репо/.scripts/mcp/mcp-servers/mcp-gitlab/index.js"]
    }
  }
}
```

---

## Справка: что такое `mr_iid` и где его найти

`iid` (internal id) — это **порядковый номер MR внутри проекта**. Именно его видно в интерфейсе GitLab.

**Три способа найти `iid`:**

1. **URL в браузере** — число в конце адреса:

   ```
   .../merge_requests/1702
                      ^^^^  → mr_iid: 1702
   ```

2. **Заголовок MR** — `!1702` (восклицательный знак + число):

   ```
   !1702  Добавить авторизацию
   ─────
   это iid
   ```

3. **Список MR** — колонка "ID" в интерфейсе показывает именно `!iid`.

**Почему не `id`?**  
В ответах GitLab API присутствуют оба поля рядом — глобальный `id` (уникален по всему серверу, в интерфейсе не виден) и проектный `iid`. Для всех вызовов этого MCP сервера используй `iid` — то самое число, которое видно в браузере.

Ошибка «`merge_request_iid is invalid`» означает, что передан глобальный `id` вместо `iid`.

---

## Доступные инструменты

### `get_mr_comments`

Получить комментарии из MR. Системные и resolved комментарии отфильтровываются.

**Поведение при большом объёме данных:**  
Полный JSON сохраняется в temp-файл (`os.tmpdir()`). В чат возвращается компактный summary (~1–2 KB):

- Счётчики (total / general / inline / skipped)
- Путь к файлу с полным JSON
- Все general комментарии (текст обрезан до 300 символов)
- Первые 5 inline комментариев (текст обрезан до 300 символов)

Temp-файлы (prefix `mcp-gitlab-mr-`) удаляются автоматически при следующем вызове, если им > 30 минут.

**Параметры:**

| Параметр     | Тип              | Обязательный | Описание                                                                                                                                                       |
| ------------ | ---------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mr_iid`     | number           | Да           | Номер MR в проекте (тот, что в URL: `!1702` → `1702`)                                                                                                          |
| `project_id` | string \| number | Нет          | `namespace/name` или числовой ID. По умолчанию: `namespace/project`                                                                                   |
| `verbose`    | boolean          | Нет          | `false` (default) — возвращает compact summary. `true` — возвращает сырой JSON discussions от GitLab (используй только для отладки; при большом MR зависит UI) |

**Пример:**

```json
{ "mr_iid": 1702 }
```

**Пример ответа (compact summary):**

```
MR Comments: 12 active (2 general, 10 inline)
Skipped: 8 resolved, 3 system
Full JSON saved to: /tmp/mcp-gitlab-mr-1702-1746000000000.json

=== General Comments ===
[abc123] @reviewer: Нужно добавить валидацию на входе…

=== Inline Comments ===
[def456] src/service.ts:142 @reviewer: Здесь лучше использовать…
… and 5 more inline comments (see full JSON file)
```

---

### `get_mr_info`

Получить мета-информацию о MR. Используется перед `add_mr_diff_comment` для получения SHA коммитов.

**Параметры:**

| Параметр     | Тип              | Обязательный | Описание                                   |
| ------------ | ---------------- | ------------ | ------------------------------------------ |
| `mr_iid`     | number           | Да           | Номер MR                                   |
| `project_id` | string \| number | Нет          | По умолчанию: `namespace/project` |

**Возвращает:** `iid`, `title`, `source_branch`, `target_branch`, `web_url`, `diff_refs` (`base_sha`, `head_sha`, `start_sha`).

---

### `add_mr_comment`

Добавить общий комментарий к MR (не привязан к строке кода).

**Параметры:**

| Параметр     | Тип              | Обязательный | Описание                                   |
| ------------ | ---------------- | ------------ | ------------------------------------------ |
| `mr_iid`     | number           | Да           | Номер MR                                   |
| `body`       | string           | Да           | Текст комментария                          |
| `project_id` | string \| number | Нет          | По умолчанию: `namespace/project` |

---

### `add_mr_diff_comment`

Добавить комментарий к конкретной строке в diff MR.  
SHA коммитов получай через `get_mr_info` (поле `diff_refs`).

**Параметры:**

| Параметр      | Тип              | Обязательный | Описание                                      |
| ------------- | ---------------- | ------------ | --------------------------------------------- |
| `mr_iid`      | number           | Да           | Номер MR                                      |
| `body`        | string           | Да           | Текст комментария                             |
| `file_path`   | string           | Да           | Путь к файлу относительно корня репо          |
| `line_number` | number           | Да           | Номер строки в новой версии файла             |
| `base_sha`    | string           | Да           | SHA базового коммита (`diff_refs.base_sha`)   |
| `head_sha`    | string           | Да           | SHA head коммита (`diff_refs.head_sha`)       |
| `start_sha`   | string           | Нет          | SHA start коммита (по умолчанию = `base_sha`) |
| `project_id`  | string \| number | Нет          | По умолчанию: `namespace/project`    |

---

### `reply_to_discussion`

Ответить на существующую нить обсуждения (discussion).  
`discussion_id` получай из `get_mr_comments` (поле `discussion_id` в каждом комментарии).

**Параметры:**

| Параметр        | Тип              | Обязательный | Описание                                           |
| --------------- | ---------------- | ------------ | -------------------------------------------------- |
| `mr_iid`        | number           | Да           | Номер MR                                           |
| `discussion_id` | string           | Да           | ID нити (SHA-подобная строка из `get_mr_comments`) |
| `body`          | string           | Да           | Текст ответа                                       |
| `project_id`    | string \| number | Нет          | По умолчанию: `namespace/project`         |

---

### `resolve_mr_discussion`

Пометить нить обсуждения как resolved.

**Параметры:**

| Параметр        | Тип              | Обязательный | Описание                                   |
| --------------- | ---------------- | ------------ | ------------------------------------------ |
| `mr_iid`        | number           | Да           | Номер MR                                   |
| `discussion_id` | string           | Да           | ID нити                                    |
| `project_id`    | string \| number | Нет          | По умолчанию: `namespace/project` |

---

### MR, issues и пайплайны

Во всех инструментах `project_id` необязателен — по умолчанию `namespace/project`.

| Инструмент            | Параметры                                                                                | Описание                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `list_mrs`            | `source_branch`, `target_branch`, `state`, `search`, `per_page`                          | Список MR по фильтрам. Обязателен после обрыва связи вместо повтора        |
| `create_mr`           | `source_branch`, `title`, `target_branch` (`develop`), `description`, `squash`, `labels` | Создание MR. При уже открытом MR по ветке возвращает его, дубль не создаёт |
| `update_mr`           | `mr_iid` + любое из `title`, `description`, `target_branch`, `labels`, `state_event`     | Обновление MR                                                              |
| `get_mr_changes`      | `mr_iid`                                                                                 | Изменённые файлы с `+N/-M`; полный diff — во временный файл                |
| `get_issue`           | `issue_iid`                                                                              | Issue целиком; длинное описание уезжает в файл                             |
| `list_issues`         | `labels`, `state`, `search`, `milestone`, `per_page`                                     | Список issues                                                              |
| `create_issue`        | `title`, `description`, `labels`, `milestone_id`, `assignee_ids`                         | Создание issue                                                             |
| `update_issue`        | `issue_iid` + `title`/`description`/`labels`/`add_labels`/`remove_labels`/`state_event`  | Обновление issue                                                           |
| `get_pipeline_status` | `mr_iid` **или** `ref`                                                                   | Последний пайплайн; при падении — список упавших job'ов                    |

---

## Слеш-команды проекта

```
/get-comment 1702      # Получить ремарки из MR и сохранить в файл
/reply-comment 1702    # Проанализировать исправления и отправить ответы
```

Файлы сохраняются в `.swap/review/`.

---

## Troubleshooting

### Фриз UI Cursor при получении комментариев

Раньше при больших MR (35KB+ JSON) Cursor зависал с диалогом "Подождать / Остановить".  
Решено: `get_mr_comments` теперь сохраняет полный JSON в temp-файл, в чат возвращает только compact summary.

Если фриз всё равно есть — включи дебаг и посмотри `summary_bytes` vs `response_bytes` в логе.

### «`merge_request_iid is invalid`»

Передаёшь глобальный `id` вместо проектного `iid`. Открой MR в браузере — число в URL и есть `iid`.

### Ошибка 401 / 403

Проверь `GITLAB_TOKEN`. Токен должен иметь права `api` или `read_api` + `write_repository` для записи комментариев.

### MCP сервер не запускается

```bash
cd .scripts/mcp/mcp-servers/mcp-gitlab
npm install
node index.js  # должен молчать и ждать stdin
```

### Отладка конкретного вызова

```bash
MCP_DEBUG=true MCP_DEBUG_LOG_FILE=/tmp/mcp-debug.log node index.js
# в другом терминале — отправить JSON-RPC вручную или использовать клиент
tail -f /tmp/mcp-debug.log
```

Ключевые события в логе:

- `tool_call_start` — вызов инструмента получен
- `gitlab_api_request` / `gitlab_api_response` — HTTP к GitLab
- `get_mr_comments_dump_written` — temp-файл создан, указан путь и `response_bytes`
- `get_mr_comments_stage_done` — завершение, `summary_bytes` (то, что пошло в чат)
- `[slow]` префикс — вызов превысил `MCP_DEBUG_SLOW_MS`
- `temp_files_cleanup` — удалены старые temp-файлы

---

## Как приспособить к своему проекту

1. **Обязательные переменные.** `GITLAB_TOKEN` и `GITLAB_URL` (вместе с `/api/v4`).
   Без любой из них сервер завершается с понятным сообщением, а не работает вслепую.
   `DEFAULT_PROJECT_ID` необязателен: без него `project_id` передаётся в каждом вызове.
2. **Источники токена.** Порядок: переменные процесса → `.env` рядом с `index.js` →
   `~/.cursor/gitlab-token` → `.envrc` в корне репозитория. Последний шаг нужен потому,
   что `direnv` до MCP-процесса не доходит.
3. **Под GitHub.** Модель дискуссий другая: у GitLab тред резолвится отдельным вызовом
   по `discussion_id`, у GitHub комментарии привязаны к review. Переписывается слой
   запросов; набор инструментов сохраняется.
4. **Отладка.** `MCP_DEBUG=1` включает лог в stderr и файл, `MCP_DEBUG_SLOW_MS`
   задаёт порог «медленного» вызова. Полезно, когда клиент молча не видит инструментов:
   в логе видно, дошёл ли вообще запуск до регистрации.

### Что важно про создание MR

`create_mr` не создаёт дубль: если по ветке уже есть открытый MR, инструмент возвращает
его. Заголовок обязан проходить проверки твоего CI — при squash именно он становится
итоговым сообщением коммита в целевой ветке.
