# Артефакты ночного прогона: где лежат и как читать

Конкретика — под GitLab CI и коллекции запросов проекта-примера. Подставь свои имена
джоб и пути; смысл каждого пункта от CI-системы не зависит.

## Схема пайплайна

Запускается по расписанию, на выделенном раннере.

Порядок джоб (важен для диагностики):

```
build:     nightly:build:app → nightly:build:infra:deps → nightly:build:infra:build
           → nightly:build:containers → nightly:build:manifest
           → nightly:setup:infra-services → nightly:setup:seed → nightly:setup:app-services
test:      nightly:test:unit | nightly:test:collections | nightly:test:e2e
notify:    nightly:collect:service-logs (when: on_failure) → nightly:notify:failure
clean-up:  nightly:cleanup:services (when: always)
```

Письмо о падении отправляет джоба уведомления с `when: on_failure`, то есть по падению
**любой** джобы пайплайна. Красной может быть не джоба прогона коллекций, а unit-тесты
или любая из setup-джоб — первым делом смотри статусы джоб, а не ищи упавшую коллекцию.

Compose-джобы имеет смысл сериализовать через `resource_group` — иначе два ночных
прогона на одном раннере затопчут друг друга.

## Почему в trace нет деталей

Джоба прогона вызывает раннер с `--silent`, поэтому в лог идут только строки прогресса
вида `[N/M] start: <collection>` и сводка в конце. Детали падений — исключительно
в артефактах.

Полезное из trace всё же есть: **первая строка**

```
Filters: include_regexp=<none>, exclude_regexp=<none>, filter=<none>
```

Это фактические фильтры прогона. Значение из расписания перекрывает значение, заданное
в job, поэтому проверять надо здесь, а не в YAML.

## Раскладка артефактов

Джоба прогона, артефакт `tests/run-reports/nightly-<PIPELINE_ID>/`:

```
last-run.json                       агрегат последнего прогона (копия summary.json)
last-run.md, last-run.html
runs/<runId>/
├── summary/summary.json            полный агрегат: totals + список коллекций
├── summary/summary.md              то же в markdown, удобно читать глазами
├── summary/summary.html
└── collections/
    ├── html/<collection>.html      дашборд по коллекции
    └── log/<collection>.log        построчный лог; отсюда время старта коллекции
```

**Per-collection JSON в ночных артефактах может отсутствовать** — если джоба запускается
с `--log-formats html,log`. Тогда машинно-читаемый источник по коллекциям — `summary.json`
или `last-run.json`, а полный отчёт по конкретной коллекции получают локальным
перепрогоном с `--log-formats json`.

Джоба сбора логов, артефакт `service-logs/`: по файлу на сервис. Формат строки —
`<service> | <iso-ts> {json}`, парсить поиском `{"ts"`.

⚠️ **Логов инфраструктуры (база, брокер) там обычно нет** — она исключена из сбора.
Если разбираешь Класс B, это первое, чего не хватит.

## Скачивание через API

`glab` в окружении не предполагается; работать через REST API.

```bash
source .envrc 2>/dev/null          # direnv не доходит до неинтерактивных оболочек
PROJECT=$(printf '%s' "${DEFAULT_PROJECT_ID}" | sed 's|/|%2F|g')   # слэш обязан быть %2F

# последний ночной прогон, если номер неизвестен
curl -s "$GITLAB_URL/projects/$PROJECT/pipeline_schedules/<SCHEDULE_ID>/pipelines?per_page=5&order_by=id&sort=desc" \
     -H "PRIVATE-TOKEN: $GITLAB_TOKEN" | jq -r '.[] | "\(.id) \(.status) \(.created_at)"'

# джобы пайплайна
curl -s "$GITLAB_URL/projects/$PROJECT/pipelines/<PIPELINE_ID>/jobs?per_page=100" \
     -H "PRIVATE-TOKEN: $GITLAB_TOKEN" | jq -r '.[] | "\(.id) \(.name) \(.status) \(.started_at)"'

# лог джобы
curl -s "$GITLAB_URL/projects/$PROJECT/jobs/<JOB_ID>/trace" -H "PRIVATE-TOKEN: $GITLAB_TOKEN"

# артефакты (zip)
curl -s "$GITLAB_URL/projects/$PROJECT/jobs/<JOB_ID>/artifacts" \
     -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -o artifacts.zip
```

`GITLAB_URL` уже включает `/api/v4`. Если корпоративный CA не в системном хранилище —
`NODE_EXTRA_CA_CERTS` для Node или `--cacert` для curl (`curl -k` — только для разовой
диагностики, не в скриптах).

Часть операций доступна через MCP-сервер
[`gitlab`](../../../tools/mcp-servers/mcp-gitlab/) (`get_pipeline_status`), но артефакты
качаются только curl'ом.

## Чтение отчётов

### Статус коллекции

Считать по **ассертам**, не по запросам:

```bash
jq -r '.collections[]
       | select(.isFailed or (.failures//0)>0 or (.runFailures//0)>0)
       | "\(.name)  assert:\(.assertionFailures//.failures//0)  script:\(.scriptFailures//0)"' \
   last-run.json
```

`requests.failed: 0` означает лишь, что HTTP-ответ дошёл — 504 тоже «успешный запрос».

### Дашборд коллекции

- `Total Failed Tests` и вкладка `Failed Tests` — упавшее.
- `Total Assertions` — всего ассертов, **не** упавших. Частый источник неверных выводов.

### Тайминги для разбора медленных ответов

- End-to-end время запроса — в логе шлюза, строки вида
  `<= 200 GET /api/... [+703.963 ms]`.
- Разбивка внутри сервиса — в логе самого сервиса: у долгих выборок это отдельные поля
  длительности в строке завершения операции.
- Стоимость обращений к кэшу — в логе сервиса данных: строки вида
  `cache MISS for <операция>, generated in Nms` / `HIT ... retrieved in Nms`.

⚠️ **Идентификатор запроса из отчёта прогона в логах сервисов обычно не встречается.**
Окно ищется по времени: старт коллекции берётся из `collections/log/<collection>.log`,
метки в логах — UTC. Это первое, обо что спотыкаются: кажется, что достаточно грепнуть
по `X-Request-Id`.

## Признаки трёх внешних причин в артефактах

| Причина | Что искать |
| --- | --- |
| Данные загружены после старта сервисов | Время джобы старта сервисов раньше джобы загрузки данных; в `service-logs`: `doesn't exist` на update, «id not found» или «archived/deleted» на create |
| Чужой код в образе | Trace джобы сборки базового образа — секунды выполнения и сообщение о существующих образах; в джобе сборки слой сборки отработал по кэшу |
| Фильтр из расписания | Первая строка trace джобы прогона |
