# MCP инструменты

## Приоритет: MCP First

**Философия:** "10 grep calls vs 1 serena call" — MCP инструменты эффективнее и точнее.

| Задача                 | ✅ Используй                                        | ❌ Не используй         |
| ---------------------- | --------------------------------------------------- | ----------------------- |
| Поиск по коду/символам | `serena` (find_symbol, find_referencing_symbols)    | Множественные `rg`/`fd` |
| Семантический поиск    | `vectorcode` (vectorcode_search)                    | Pattern-based grep      |
| Поиск в документации   | `knowledge-graph` (search_nodes)                    | `rg` в .docs/           |
| История/patterns       | `devcontext` (search_events, search_patterns)       | git log analysis        |
| Запросы к БД           | `dgraph` (dgraph_query, dgraph_mutate)              | curl к базе             |
| Тикеты в трекере       | `openproject` (get_work_package, …)                 | `curl` к API трекера    |
| MR, issues, пайплайны  | `gitlab` (create_mr, get_issue, …)                  | `curl`, `glab`          |

**Когда прямые tools допустимы:**

- Single-shot точечный поиск (известный файл/паттерн)
- MCP сервер недоступен или вернул ошибку
- Операции с файловой системой, git, npm

**Метрика:** Если задача требует более 3 grep/fd вызовов → используй MCP.

## Настроенные серверы

Три сервера из этого списка лежат в репозитории готовыми — `tools/mcp-servers/`.
`serena` и `memory` ставятся отдельно, как обычные MCP-серверы.

- ✅ **dgraph** — БД: query, search, stats, mutate (шаблон под свою базу)
- ✅ **serena** — интеллектуальный поиск по коду
- ✅ **memory** — граф знаний для долговременной памяти
- ✅ **gitlab** — GitLab: ремарки MR, создание MR, issues, пайплайны
- ✅ **openproject** — тикеты трекера: чтение, комментарии, вложения, время

### gitlab

> Раньше сервер назывался `get-comments` и умел только ремарки MR. Переименован вместе
> с расширением: инструменты теперь `mcp__gitlab__*`, каталог — `mcp-gitlab`.

Код: `tools/mcp-servers/mcp-gitlab/index.js`.
Cursor запускает его через launcher-обёртку (Cursor Agent CLI не подставляет
`${workspaceFolder}` в `args`, поэтому путь вычисляется от самого launcher'а).

`(write)` — инструмент меняет состояние на сервере; такие не автоподтверждаются.

| Инструмент                                                                        | Когда                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `get_mr_comments`, `reply_to_discussion` (write), `resolve_mr_discussion` (write) | работа с ремарками (`/get-comment`, `/resolve-remarks`) |
| `add_mr_comment` (write), `add_mr_diff_comment` (write)                           | комментарий к MR или к строке diff                      |
| `get_mr_info`                                                                     | SHA для diff-комментариев                               |
| `list_mrs`                                                                        | проверить, существует ли MR по ветке                    |
| `create_mr` (write), `update_mr` (write)                                          | создать/поправить MR вместо `push -o`                   |
| `get_mr_changes`                                                                  | список изменённых файлов MR со статистикой              |
| `get_issue`, `list_issues`, `create_issue` (write), `update_issue` (write)        | issues проекта                                          |
| `get_pipeline_status`                                                             | статус пайплайна по MR или ветке, упавшие job'ы         |

**`create_mr` не создаёт дубль:** если по ветке уже есть открытый MR — возвращает его.
Заголовок обязан проходить commitlint (при squash он становится итоговым commit'ом).

### openproject (тикеты)

Код: `tools/mcp-servers/mcp-openproject/index.js`.

| Инструмент                            | Когда                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `get_work_package`                    | прочитать тикет по ID (тип, статус, описание, `lockVersion`)             |
| `get_work_package_activities`         | комментарии тикета; `include_changes` добавляет историю полей            |
| `get_work_package_attachments` (диск) | список вложений; `download: true` — скачать скриншоты и читать их `Read` |
| `add_work_package_comment` (write)    | опубликовать комментарий                                                 |
| `update_work_package` (write)         | статус (по имени), тема, описание, % готовности, исполнитель             |
| `log_time` (write)                    | списать время                                                            |
| `search_work_packages`                | поиск по теме/статусу/типу/дате в проекте `OPENPROJECT_PROJECT`          |

`update_work_package` сам подтягивает `lockVersion` — без него сервер отвечает 409.

`get_work_package_attachments` с `download: true` пишет файлы на диск, поэтому не
автоподтверждается. Каталог создаётся с правами `0700`, файлы — `0600`, имена вложений
санитизируются (сервер может прислать `fileName` с путём). **Файлы не удаляются
автоматически** — чистить вручную, если в скриншотах чувствительные данные.

### Переменные окружения серверов

Оба сервера берут переменные в порядке: **окружение процесса → `.env` рядом с сервером →
`.envrc` в корне репозитория**. Третий шаг важен: direnv до MCP-процесса не доходит,
а `$PWD` внутри `.envrc` раскрывается по каталогу самого файла (там так задан путь к CA).

`NODE_EXTRA_CA_CERTS` сервер трекера читает **сам** и добавляет к системным корням —
Node разбирает эту переменную только на старте процесса, а одиночный CA без системных
корней рвёт цепочку (`unable to get issuer certificate`).

### Поведение при обрыве связи

Сетевые ошибки классифицируются: таймаут, недоступность (VPN), проблема сертификата.
Для POST/PUT/PATCH/DELETE и 5xx в текст ошибки добавляется предупреждение, что
**состояние на сервере неизвестно** — повторять вслепую нельзя, сначала перечитать
(`list_mrs`, `get_mr_comments`, `get_work_package_activities`).

### Деградация на curl

MCP-сервер может быть не поднят (headless/cron-прогон, свежий клон без `npm install`
в каталоге сервера). Скиллы в этом случае возвращаются к `curl` — путь описан в самих
скиллах (`/read-bug`, `/mr`). Признак недоступности: инструмент `mcp__…` отсутствует
или отвечает ошибкой запуска, а не ошибкой API.

## Конфигурация

- **Claude Code (проект):** `.mcp.json` в корне — источник истины для serena, dgraph,
  gitlab, openproject
- **Cursor:** `.cursor/mcp.json` (+ launcher-обёртки для серверов с относительным путём)
- **opencode:** `opencode.jsonc` — те же серверы, относительные пути
- **Claude Desktop:** `~/.config/Claude/claude_desktop_config.json`

⚠️ Новый или изменённый сервер подхватывается только после перезапуска сессии
(`/mcp` → reconnect либо рестарт Claude Code) — в текущей сессии его инструментов нет.

**Автоподтверждение инструментов задаётся в разных местах:**

- Claude Code — `permissions.allow` в `.claude/settings.json` (поимённо,
  `mcp__gitlab__get_issue`). Поле `alwaysAllow` в `.mcp.json` **не входит в схему** и
  молча игнорируется — не полагаться на него.
- Cursor — `alwaysAllow` в `.cursor/mcp.json`.

Под автоподтверждение попадают только читающие инструменты: мутации и запись на диск
подтверждаются вручную.

**Проверка:**

```bash
nc -zv localhost 19080                                    # порт базы
test -f tools/mcp-servers/mcp-dgraph-server/dist/index.js && echo "OK"
jq '.mcpServers | keys' .mcp.json                         # серверы проекта
# зависимости серверов не в гите — после свежего клона:
npm install --prefix tools/mcp-servers/mcp-openproject
npm install --prefix tools/mcp-servers/mcp-gitlab
```
