description: Сгенерировать и заполнить описание MR (адаптивный шаблон) и опционально создать MR

---

Ты помощник по подготовке Merge Request. Действуй строго по шагам. Анализ — на русском.

## Аргументы

- `--push` — после заполнения создать/обновить MR через GitLab API.
- `--target <branch>` — целевая ветка (по умолчанию `develop`).

## Шаги

1. Получи детерминированный контекст:
   `node .scripts/mr-template/index.mjs context [--target <branch>]`
   Распарси JSON. Скрипт сам делает `git fetch origin <target>` и считает
   diff/commits против `origin/<target>` (поле `diffBase` в JSON показывает
   фактическую базу; `origin/<target>` — сравнение с remote, `<target>` — fallback
   на локальную ветку при offline/отсутствии remote). Сверь `commits`: там должны
   быть ТОЛЬКО коммиты текущей задачи. Если видишь чужие `[TASK-*]` или
   `diffBase == <target>` без `origin/` — remote недоступен, предупреди пользователя.

2. **Если `needsTaskId == true` и `type == null`:**
   спроси у пользователя номер задачи в трекере. Если пользователь НЕ вводит номер —
   **прерви команду** (ничего не пиши и не публикуй). Иначе повтори шаг 1 с `--task <N>`.

3. **Если `type == null`** (трекер недоступен, но номер есть):
   спроси у пользователя тип: `bug` / `feature-task` / `task`.

4. Получи адаптивный скелет:
   `node .scripts/mr-template/index.mjs skeleton --task <taskId> [--target <branch>]`

5. Заполни ТОЛЬКО прозу в плейсхолдерах `<!-- AI: ... -->`, опираясь на:
   - `commits`, `diffstat` из контекста — для «Что сделано» / «Исправление»;
   - `blameHints` — для «Когда/кем привнесено» (баг); явно отметь, что это предположение;
   - `testFilesInDiff` — для «Регресс-тест» (если тестов нет — оставь чекбоксы пользователю).
     Чекбоксы «Почему не нашли» и «Регресс-тест не нужен» НЕ отмечай — это решает человек.
     Делегируй написание прозы субагенту на модели Haiku (Task tool, subagent_type general-purpose,
     model haiku) — передай ему скелет + нужные поля контекста, верни заполненный markdown.

6. Сформируй MR title в формате `type(scope): [TASK-<id>] <subject>` (без кириллицы, ≤72).
   `type` = `fix` для bug, иначе `feat`/`chore` по смыслу; `scope` — из затронутых сервисов.

7. Сохрани итог во временный файл и опубликуй:
   `node .scripts/mr-template/index.mjs publish --file <tmp> --title "<title>" [--push] [--target <branch>]`
   Выведи пользователю путь к файлу и (если был `--push`) ссылку `webUrl` либо сообщение о fallback.

   **Если publish оборвался по таймауту** — не повторять вслепую: проверь фактическое
   состояние через `mcp__gitlab__list_mrs(source_branch: "<ветка>")`. MR уже есть —
   правь его `mcp__gitlab__update_mr(mr_iid, description/title)`, а не создавай второй.
   Статус пайплайна по этому же MR — `mcp__gitlab__get_pipeline_status(mr_iid: <iid>)`.

8. Выведи итоговое описание как **raw markdown в code block** для копирования.
