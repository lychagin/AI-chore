# /swarm — Запуск роя агентов

Запускает рой агентов для работы над указанным Use Case.

> Конкретика ниже — [проект-пример OrderShop](../examples/example-project.md).
> Что подставлять под свой проект — раздел «Точки подстановки» в конце файла
> и [`agents/README.md`](../agents/README.md).

## Использование

```
/swarm UC-002        # Запустить рой для UC-002 (foreground — главная вкладка = дашборд)
/swarm UC-002 --bg   # Запустить в background (для параллельных UC)
/swarm               # Показать справку
```

## Аргументы

- `$ARGUMENTS` — номер Use Case и опциональный флаг:
  - `UC-<номер>` — запуск в foreground (по умолчанию)
  - `UC-<номер> --bg` — запуск team-leader в background

## Настройка watchdog

Таймаут обнаружения зависшего агента задаётся через переменную окружения:

```bash
export WARN_MINUTES=10   # алерт если агент не обновлял heartbeat N минут (default: 10)
```

Устанавливается в `.envrc`. Переопределяется на лету: `WARN_MINUTES=20 /swarm UC-002`.

---

## Логика

### Если аргумент не передан — показать справку

Выведи следующую справку:

```
Agent Swarm — координация разработки через рой агентов

Использование:
  /swarm UC-<номер>     Запустить рой для указанного use case

Текущий модуль: $SWARM_MODULE (из .envrc)
Конфигурация:   $SWARM_MODULE_DIR/.agent-config.yaml

Настройка модуля (в .envrc):
  export SWARM_MODULE=orders
  export SWARM_MODULE_DIR=.swap/requirements/use_cases/orders

Документация:
  .claude/agents/README.md — состав роя и как адаптировать его под свой проект
```

Дополнительно:

1. Проверь `$SWARM_MODULE` — если задан, покажи его значение
2. Если `$SWARM_MODULE_DIR/.agent-config.yaml` существует — прочитай `module.name` и покажи
3. Выведи список UC из `$SWARM_MODULE_DIR/use_cases.md` (если файл существует)

**Завершить выполнение.** Не запускать рой.

---

### Если аргумент передан — запустить рой

#### 0. Зафиксировать UC_ID и режим запуска из аргумента команды

Из `$ARGUMENTS` извлечь:

- **UC_ID** — токен вида `UC-<номер>` (например `UC-002`)
- **SWARM_BACKGROUND** — `true` если присутствует флаг `--bg`, иначе `false`

Примеры:

- `UC-002` → UC_ID=`UC-002`, SWARM_BACKGROUND=`false`
- `UC-002 --bg` → UC_ID=`UC-002`, SWARM_BACKGROUND=`true`
- `--bg UC-002` → UC_ID=`UC-002`, SWARM_BACKGROUND=`true`

**Не переменная окружения.** Каждый Bash-вызов — отдельный подпроцесс, `export` между
ними не работает. Значение держится в рабочей памяти и подставляется литерально при
каждом вызове.

Сразу вывести в stdout режим запуска:

```
🐝 SWARM <UC_ID> [<SWARM_MODULE>] — запуск в режиме foreground
```

или

```
🐝 SWARM <UC_ID> [<SWARM_MODULE>] — запуск в режиме background (--bg)
```

#### 1. Определить модуль

```bash
echo $SWARM_MODULE
echo $SWARM_MODULE_DIR
```

Если `$SWARM_MODULE` не задан:

- Найти все модули: поискать `.agent-config.yaml` в `.swap/requirements/use_cases/*/`
- Показать список найденных модулей
- Спросить пользователя, какой выбрать (AskUserQuestion)
- Установить переменные для текущей сессии

#### 1.5. Проверить наличие плагина маршрутизации контекста (опционально)

Если в проекте используется плагин, уводящий вывод тяжёлых команд мимо основного
контекста, — определить его доступность по наличию его инструментов в `system-reminder`
либо по наличию его каталога в `~/.claude/plugins/cache/`.

Установить переменную для текущей сессии:

```
CONTEXT_ROUTING_AVAILABLE = true | false
```

Если плагина нет — продолжить без него. Никаких предупреждений не выводить.

#### 1.7. Очистить логи текущего UC

```bash
# Очищаем только директорию текущего UC — параллельные запуски других UC не затрагиваются
UC_LOG_DIR=".agent-messages/logs/$SWARM_MODULE/$UC_ID"
rm -rf "$UC_LOG_DIR"
mkdir -p "$UC_LOG_DIR"
echo "Логи UC очищены: $UC_LOG_DIR"
```

#### 2. Создать инфраструктуру

```bash
# Директории для обмена сообщениями
mkdir -p .agent-messages/inbox/$SWARM_MODULE/$UC_ID/{analyst,architect,reviewer,coder,tester,troubleshooter,tech-writer,team-leader,final-reviewer}
mkdir -p .agent-messages/outbox/$SWARM_MODULE/$UC_ID/{analyst,architect,reviewer,coder,tester,troubleshooter,tech-writer,team-leader,final-reviewer}
mkdir -p .agent-messages/shared/$SWARM_MODULE/use-cases
mkdir -p .agent-messages/shared/$SWARM_MODULE/decisions
mkdir -p .agent-messages/logs/$SWARM_MODULE/$UC_ID
```

#### 3. Создать папку UC в постоянном хранилище

```bash
mkdir -p $SWARM_MODULE_DIR/use-cases/$UC_ID
mkdir -p $SWARM_MODULE_DIR/use-cases/$UC_ID/docs
```

#### 4. Инициализировать состояние

Создать или обновить `.agent-messages/shared/$SWARM_MODULE/team-leader-state-$UC_ID.json`:

```json
{
  "current_task": "$UC_ID",
  "module": "$SWARM_MODULE",
  "module_dir": "$SWARM_MODULE_DIR",
  "phase": "requirements",
  "active_agent": null,
  "agent_started_at": null,
  "history": [],
  "pending_user_questions": [],
  "design_assets": null,
  "escalations": [],
  "analyst_notes": []
}
```

#### 5. Запустить watchdog-мониторинг

Watchdog запускается всегда — в обоих режимах. Поведение отличается:

- **foreground** (`SWARM_BACKGROUND=false`): алерты зависания выводятся в чат через
  Monitor — пользователь видит их и принимает решение вручную. Team-leader не реагирует
  автоматически (ограничение режима: он заблокирован на субагенте). Для автоматической
  реакции — используй `--bg`.
- **background** (`SWARM_BACKGROUND=true`): регулярный статус в чат каждые 5 минут плюс
  алерты зависания. Team-leader свободен и может отреагировать.

```bash
MODULE="$SWARM_MODULE"
LOGDIR=".agent-messages/logs/${MODULE}/${UC_ID}"
STATE=".agent-messages/shared/${MODULE}/team-leader-state-${UC_ID}.json"
VERBOSE="${SWARM_BACKGROUND}"   # true = background режим, false = foreground

bash -c "
  LOG='${LOGDIR}/swarm-monitor.log'
  VERBOSE='${VERBOSE}'
  CHECKS=0
  echo \"[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] MONITOR [${MODULE}/${UC_ID}]: started (verbose=\${VERBOSE})\" >> \"\$LOG\"

  while true; do
    sleep 60
    CHECKS=\$((CHECKS + 1))
    [ ! -f '${STATE}' ] && continue

    read -r ACTIVE PHASE < <(python3 -c \"import json; d=json.load(open('${STATE}')); print(d.get('active_agent') or '', d.get('phase') or '')\" 2>/dev/null)

    if [ -z \"\$ACTIVE\" ]; then
      [ \"\$PHASE\" = 'done' ] && {
        echo \"[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] MONITOR: complete\" >> \"\$LOG\"
        echo \"[SWARM ${MODULE}/${UC_ID}] ✅ Pipeline complete\"
        break
      }
      continue
    fi

    HB='${LOGDIR}/heartbeat-'\"\${ACTIVE}\".json
    if [ -f \"\$HB\" ]; then
      python3 - <<PYEOF
import json, datetime

verbose = '${VERBOSE}' == 'true'
checks  = int('\${CHECKS}')     # номер текущей проверки (каждые 60с)
WARN    = ${WARN_MINUTES:-10}  # настраивается через env WARN_MINUTES (default: 10 мин)

d       = json.load(open('${LOGDIR}/heartbeat-' + '\${ACTIVE}' + '.json'))
agent   = d.get('agent', '?')
step    = d.get('step', '?')
pct     = d.get('progress_pct', '?')
status  = d.get('status', '?')
last_upd = d.get('last_update', '')

try:
    ts = datetime.datetime.fromisoformat(last_upd.replace('Z', '+00:00'))
    elapsed = int((datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds() // 60)
except Exception:
    elapsed = 0

# В verbose (background) режиме — печатать статус каждые 5 проверок (= 5 мин)
if verbose and checks % 5 == 0:
    print(f'[SWARM ${MODULE}/${UC_ID}] {agent} | {step} | {pct}% | {elapsed}min ago')

# В обоих режимах — алерт при зависании
if elapsed >= WARN and status == 'in_progress':
    print(f'[SWARM ${MODULE}/${UC_ID}] ⚠️  HANG: {agent} — нет обновлений {elapsed}мин (шаг: {step}, прогресс: {pct}%)')
PYEOF
    else
      echo \"[SWARM ${MODULE}/${UC_ID}] ⚠️  HANG: '\${ACTIVE}' — heartbeat файл отсутствует\"
    fi
  done
" &
echo $! > "${LOGDIR}/monitor.pid"
```

Использовать `Monitor` tool с PID из `${LOGDIR}/monitor.pid`:

- **foreground**: Monitor активен и выводит алерты зависания в чат. Team-leader не
  реагирует автоматически — пользователь видит алерт и вмешивается вручную.
- **background**: Monitor выводит статус каждые 5 минут плюс алерты зависания.

#### 5.5. Запустить team-leader

Запустить team-leader агента (Agent tool, `subagent_type: team-leader`).

- Если `SWARM_BACKGROUND = false` → **run_in_background: false** (foreground,
  главная вкладка = дашборд)
- Если `SWARM_BACKGROUND = true` → **run_in_background: true** (фоновая вкладка)

Итоговый промпт team-leader:

```
Начинаем работу над $UC_ID.

Модуль: $SWARM_MODULE
Директория модуля: $SWARM_MODULE_DIR
Конфигурация: $SWARM_MODULE_DIR/.agent-config.yaml
State файл: .agent-messages/shared/$SWARM_MODULE/team-leader-state-$UC_ID.json
Heartbeat директория: .agent-messages/logs/$SWARM_MODULE/$UC_ID/

Перед запуском каждого агента записывай agent_started_at в state.json.
После возврата агента проверяй heartbeat-<agent>.json (status == "completed").

В промпт КАЖДОГО субагента добавляй инструкцию:
"ПРАВИЛО: для ВСЕХ записей в .agent-messages/** используй ТОЛЬКО Write tool или Edit tool — НЕ bash
(cat heredoc, echo >, python3 -c). Bash-запись JSON через heredoc ненадёжна (экранирование кавычек
и переносов строк ломает файл) — Write/Edit tool единственный поддерживаемый способ.
Область действия: heartbeat JSON (.agent-messages/logs/...), outbox MSG-файлы
(.agent-messages/outbox/...), shared JSON (.agent-messages/shared/...) — покрыто разрешениями
Write(.agent-messages/**) и Edit(.agent-messages/**); запись куда-либо ещё этим грантом не покрыта."

ВАЖНО: перед запуском Analyst выполни шаг «Обязательный запрос макетов» из своих инструкций —
спроси пользователя о наличии макетов (есть / в работе / нет) и сохрани результат
в design_assets в state.json. Только после этого запускай цикл.

Запусти полный цикл разработки:
1. Analyst — анализ требований
2. Architect — ADR (включает обязательно: проектирование изменений схемы хранилища + контракт API;
   при необходимости — делегирование написания файлов data-model/ и openapi/ кодеру
   с указанием конкретных путей)
3. User — согласование модели данных + API (ОБЯЗАТЕЛЬНО перед финализацией ADR;
   см. Gate в team-leader.md)
4. Reviewer — ADR review
5. User — утверждение ADR
6. Tester — Red phase (написать тесты)
   После завершения Tester Red phase: сообщи Coder путь к артефакту стабов:
   `.agent-messages/shared/$SWARM_MODULE/use-cases/$UC_ID/stubs.json`
   (детальный Stub discovery — в инструкции coder.md)
7. Coder — реализация: код сервисов, стабы тестера, а также файлы data-model/ и openapi/
   (пути берёт из ADR — секции Storage Schema Changes и API Components;
   если архитектор делегировал — создаёт эти файлы; если архитектор уже создал —
   проверяет и дополняет)
8. Reviewer — code review
9. Tester — Green phase (запустить тесты)
10. Reviewer — test review
11. Tech-writer — документация
12. Final-reviewer — финальный code review
13. Сводка с таблицей артефактов (включая файлы data-model/ и openapi/ отдельными строками)
```

---

## Точки подстановки

| Место в файле | Сейчас (OrderShop) | Чем заменить |
| --- | --- | --- |
| Примеры модулей | `orders`, `.swap/requirements/use_cases/orders` | Своими значениями `SWARM_MODULE` и `SWARM_MODULE_DIR` |
| Формат UC-ID | `UC-002` | Своей схемой идентификаторов |
| Шаг 1.5 | плагин маршрутизации контекста | Своим плагином или удалить шаг |
| Шаги 6–7 промпта | `stubs.json`, `data-model/`, `openapi/` | Своими артефактами; если контракта API нет — убрать пункты про спецификацию |
| Список агентов в `mkdir` | 9 ролей | Своим составом, если убираешь роли |

**Watchdog переносится как есть.** Он читает только `team-leader-state-*.json` и
`heartbeat-*.json` — форматы, которые задаёт сам рой, а не проект. Единственная
внешняя зависимость — `python3` в системе.
