# MCP-серверы

Три готовых MCP-сервера на stdio: GitLab, трекер OpenProject и база DGraph. Каждый —
самостоятельный npm-пакет; зависимости в репозиторий не кладутся, ставятся на месте.

Ни один из них не устанавливается `install.sh` — MCP-серверы подключаются к клиенту
(Claude Code, Cursor, Claude Desktop) конфигом, а не копированием в `.claude/`.

Порядок подключения и правила автоподтверждения инструментов — в
[`docs/mcp-tools.md`](../../docs/mcp-tools.md).

---

## Что внутри

| Сервер | Инструменты | Кому нужен |
| --- | --- | --- |
| [`mcp-gitlab`](mcp-gitlab/) | Ремарки MR и ответы на них, создание и правка MR, issues, статус пайплайна, diff изменённых файлов | скиллы [`get-comment`](../../skills/get-comment/SKILL.md), [`resolve-remarks`](../../skills/resolve-remarks/SKILL.md), [`reply-comment`](../../skills/reply-comment/SKILL.md) |
| [`mcp-openproject`](mcp-openproject/) | Чтение тикета, комментарии, история полей, вложения со скачиванием, списание времени, поиск | скиллы работы с багами |
| [`mcp-dgraph-server`](mcp-dgraph-server/) | 12 инструментов к DGraph: query, mutate, delete, upsert, схема, статистика, поиск, экспорт, бэкап, health | прямая работа с графовой базой |

## Установка

```bash
# Зависимости ставятся отдельно для каждого сервера
npm install --prefix tools/mcp-servers/mcp-gitlab
npm install --prefix tools/mcp-servers/mcp-openproject
npm install --prefix tools/mcp-servers/mcp-dgraph-server

# Сервер DGraph написан на TypeScript — его надо собрать
npm run build --prefix tools/mcp-servers/mcp-dgraph-server
```

## Подключение к Claude Code

В `.mcp.json` в корне проекта:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["${workspaceFolder}/tools/mcp-servers/mcp-gitlab/index.js"],
      "env": {
        "GITLAB_URL": "https://gitlab.example.com/api/v4",
        "DEFAULT_PROJECT_ID": "namespace/project"
      }
    },
    "dgraph": {
      "command": "node",
      "args": ["${workspaceFolder}/tools/mcp-servers/mcp-dgraph-server/dist/index.js"],
      "env": { "DGRAPH_CONNECT_URL": "localhost:9080" }
    }
  }
}
```

Токены в `.mcp.json` **не пишутся** — файл попадает в репозиторий. Каждый сервер берёт
их в порядке: переменные процесса → `.env` рядом с сервером → `.envrc` в корне
репозитория. Третий шаг существует потому, что `direnv` до MCP-процесса не доходит:
процесс запускает клиент, а не оболочка.

> ⚠️ Новый или изменённый сервер подхватывается только после перезапуска сессии
> (`/mcp` → reconnect либо рестарт клиента). В текущей сессии его инструментов нет.

## Как приспособить к своему проекту

1. **GitLab.** Задать `GITLAB_URL` (обязательно, вместе с `/api/v4`) и токен.
   `DEFAULT_PROJECT_ID` необязателен: без него `project_id` указывается в каждом вызове.
   Умолчаний с чужими адресами в коде нет намеренно — опечатка в конфиге должна давать
   понятную ошибку, а не запросы не туда.
2. **Трекер.** Сервер написан под REST API v3 OpenProject. Для Jira или YouTrack
   переписывается слой запросов; форма инструментов (прочитать тикет, добавить
   комментарий, скачать вложение, списать время) переносится.
3. **База.** Сервер написан под DGraph. Для другой базы заменяется
   [`mcp-dgraph-server/src/dgraph-client.ts`](mcp-dgraph-server/src/dgraph-client.ts) —
   `index.ts` вызывает только `query`, `mutate`, `delete`, `upsert`, `alterSchema`.
4. **Корпоративный CA.** Если трекер за собственным центром сертификации, Node нужен
   `NODE_EXTRA_CA_CERTS` с полным бандлом: одиночный сертификат без системных корней
   рвёт цепочку (`unable to get issuer certificate`).

## Скрипт управления

`mcp-server-manager.sh {start|stop|status|restart}` — обёртка для ручного запуска
сервера DGraph вне клиента (проверка сборки, фоновый старт, PID-файл). В штатной работе
не нужен: сервер запускает сам MCP-клиент по конфигу выше.

## Поведение при обрыве связи

Все три сервера классифицируют сетевые ошибки: таймаут, недоступность, проблема
сертификата. Для запросов, меняющих состояние, и для 5xx в текст ошибки добавляется
предупреждение, что **состояние на сервере неизвестно**. Повторять вслепую нельзя —
сначала перечитать (`list_mrs`, `get_mr_comments`, `get_work_package_activities`).
