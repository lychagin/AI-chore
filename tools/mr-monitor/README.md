# MR Monitor

Скрипт мониторит один Merge Request в GitLab и автоматически доводит его до
мержа в `develop`: ждёт пайплайн, при необходимости делает rebase и держит
включённым auto-merge.

## Зачем

При параллельной работе нескольких MR первый с включённым auto-merge мержится
в `develop`, а остальные получают `Merge blocked: Fast forward merge is not
possible. Please rebase` — даже если их пайплайн прошёл. MR может висеть часами.
Скрипт снимает эту рутину: один процесс на один MR доводит его до мержа.

## Требования

- Python 3 (только стандартная библиотека — внешних пакетов не нужно).
- Переменные окружения (берутся из `.envrc` проекта):
  - `GITLAB_URL` — например `https://gitlab.example.com/api/v4`
  - `GITLAB_TOKEN` — Personal Access Token с правом `api`
  - `DEFAULT_PROJECT_ID` — например `namespace/project` (можно
    переопределить опцией `--project`)
- Для локального fallback-rebase — рабочий git-репозиторий и доступ на push
  (SSH-ключ к origin).

## Опции

```
python3 tools/mr-monitor/mr_monitor.py <mr_iid> [--interval N] [--project PATH]
```

- `mr_iid` (обязательный) — внутренний ID merge request, например `2403`.
- `--interval N` — интервал опроса в секундах. По умолчанию `300` (5 минут).
- `--project PATH` — path проекта в GitLab. По умолчанию из `DEFAULT_PROJECT_ID`.
- `--help` — справка.

Коды возврата: `0` — MR смержен; `1` — ошибка/блокер; `130` — прервано (Ctrl-C).

## Примеры

Базовый запуск (интервал 5 минут, проект из env):

```bash
python3 tools/mr-monitor/mr_monitor.py 2403
```

Свой интервал опроса (каждые 2 минуты):

```bash
python3 tools/mr-monitor/mr_monitor.py 2403 --interval 120
```

Другой проект:

```bash
python3 tools/mr-monitor/mr_monitor.py 15 --project namespace/other-repo
```

Параллельный мониторинг нескольких MR — по процессу в отдельном терминале:

```bash
# терминал 1
python3 tools/mr-monitor/mr_monitor.py 2403
# терминал 2
python3 tools/mr-monitor/mr_monitor.py 2405
```

## Что делает на каждом статусе

Скрипт опрашивает MR и смотрит на `detailed_merge_status` и
`head_pipeline.status`:

| Состояние                                                                | Действие                              |
| ------------------------------------------------------------------------ | ------------------------------------- |
| `mergeable`, `ci_still_running`, `ci_must_pass`, `checking`, `unchecked` | ждёт следующего опроса                |
| `need_rebase`                                                            | выполняет rebase (см. ниже)           |
| `conflict`                                                               | **стоп** — конфликт, решать вручную   |
| `discussions_not_resolved`, `not_approved`, `draft_status`               | **стоп** — блокер, разрулить вручную  |
| `head_pipeline.status == failed`                                         | **стоп** — пайплайн упал (со ссылкой) |
| `state == merged`                                                        | **успех** — выход 0                   |
| `state == closed`                                                        | **стоп** — MR закрыт                  |

`canceled`/`skipped` пайплайны не считаются падением (это обычно вытеснённый
пайплайн после нового push).

На первой итерации скрипт включает auto-merge (merge-when-pipeline-succeeds)
самостоятельно.

## Механизм rebase (гибрид)

1. **Серверный API GitLab** (`PUT .../rebase`) — GitLab делает rebase на своей
   стороне, флаг auto-merge сохраняется. При конфликте API возвращает
   `merge_error` → скрипт завершается с сообщением.
2. **Локальный fallback** (если API недоступен/запрещён, например 403):
   - создаётся отдельный git worktree `MR-monitoring-<iid>` рядом с
     репозиторием (по этому префиксу его легко отличить среди своих worktree);
   - `git fetch` + `git rebase origin/develop`;
   - при конфликте — `git rebase --abort` и **стоп** с сообщением;
   - при успехе — `git push --force-with-lease`, после чего auto-merge
     включается заново (force-push его сбрасывает).

Worktree удаляется автоматически при любом завершении скрипта.

---

## Как приспособить к своему проекту

1. **Адрес и проект.** `GITLAB_URL` (вместе с `/api/v4`) и токен — обязательны.
   Проект берётся из `--project-id` либо из `DEFAULT_PROJECT_ID`; умолчания с чужим
   адресом в коде нет намеренно.
2. **Путь к репозиторию.** По умолчанию — текущий каталог; переопределяется через
   `--main-repo` или `MR_MONITOR_MAIN_REPO`. Это важно при работе из git worktree:
   fetch целевой ветки делается в основном чекауте, а rebase — в worktree с веткой MR.
3. **Целевая ветка.** Определяется из самого MR, менять в коде ничего не нужно.
4. **Хостинг.** Скрипт написан под GitLab API: статус пайплайна, auto-merge,
   rebase через API. Под GitHub переписывается слой запросов; логика состояний
   (ждать пайплайн → rebase при отставании → держать auto-merge) переносится.

### О чём стоит подумать до автоматизации

Скрипт делает `push` без участия человека. Это уместно для rebase на свежую целевую
ветку и неуместно, если в ветке есть незакоммиченные правки или её параллельно
перебазирует кто-то ещё. Перед постановкой в cron прогони с `--dry-run` и посмотри,
что именно он собирается сделать.
