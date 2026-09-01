/**
 * Скрипт для Workflow tool: разбор упавших коллекций ночного прогона.
 *
 * Один агент на коллекцию, все параллельно. Каждый возвращает не текст, а структуру
 * по схеме ROOT_SCHEMA — поэтому результаты можно сводить в таблицу и считать, а не
 * перечитывать десять отчётов подряд.
 *
 * ⚠️ Запускается только при явной просьбе пользователя (см. описание Workflow tool).
 * Пятнадцать агентов — это заметный расход; сам по себе красный прогон поводом
 * для фан-аута не является.
 *
 * Конкретика ниже — проект-пример OrderShop. Что менять под свой проект — в конце файла.
 */

export const meta = {
  name: 'nightly-triage',
  description: 'Разбор упавших коллекций ночного прогона до корневых причин',
  phases: [{ title: 'Triage', detail: 'один агент на коллекцию, классификация корней' }],
}

// ---- Общий контекст, который получает каждый агент -----------------------
//
// Здесь собирается всё, что агент иначе будет выяснять сам — по разу на каждую
// из пятнадцати параллельных задач. Три блока обязательны: как достучаться до
// живого стенда, где источник истины по контракту, и какие корни уже разобраны.
const SHARED = `
Ты — диагност упавших коллекций ночного прогона.
ЗАДАЧА: определить КОРНИ падения одной коллекции и классифицировать каждый.
КОД НЕ ПРАВИТЬ — только диагностика.

ОКРУЖЕНИЕ (живое):
- Бэкенд на http://localhost:3000. Логин: POST /api/v1/auth/login
  тело {"login":"admin@example.com","password":"password"} -> 200, cookie-jar.
  Прим.: переменные окружения коллекций называются userName/userPassword,
  но САМ эндпоинт ждёт поля login/password.
- База: psql "$DATABASE_URL" -c '<query>'
- Контракт API (source of truth для валидности полей): openapi/paths/*.yaml (эндпоинты),
  openapi/components/**/*.yaml (схемы). Поле payload валидно ТОЛЬКО если есть в схеме
  request-body. Ищи: grep -rn "<field>" openapi/components openapi/paths
- application.log (корень репо, большой) — точная причина server-ошибок. Грепать по времени
  прогона (timestamp в имени отчёта):
  grep -a "missing permissions\\|Required:\\|<entity>" application.log | tail -50

МЕХАНИЗМ 403 (уже разобран, не переоткрывай): create/update проверяет право
{entity}.{field}.create на КАЖДОЕ поле payload. Пользователь прогона — администратор.
Значит 403 = либо (а) поле payload невалидно или переименовано в контракте и права под
него нет [класс test/contract], либо (б) бэкенд сам подмешивает служебное поле без права
[класс backend, прод-баг].

ИЗВЕСТНЫЕ КОРНИ (для сверки, НЕ переоткрывай — если совпало, помечай knownBug):
- #1201: shutdowns 403 из-за служебного поля checkingAvailability (backend).
- order.deliverySlotId -> должно быть deliverySlot (поле переименовано).
- accessGroup.services -> УДАЛЕНО из контракта в TASK-1042.

АЛГОРИТМ:
1. Найди последний отчёт: ls -1t tests/run-reports/<PREFIX>*.json | head -1
2. Извлеки фейлы+тела: node tools/nightly/extract-failures.js <report.json>
3. Для КАЖДОГО уникального фейла определи корень:
   - прочитай соответствующий шаг в файле коллекции (payload/ассерты):
     tests/function/<COLLECTION_FILE>
   - сверь поля payload с контрактом; при 403/422 — определи какое поле, право или
     нарушение уникальности; при 400/404/500 — прочитай тело ответа (оно есть
     в extract), при нужде грепни application.log
   - при сомнении — воспроизведи вживую (login -> тот же запрос) ПОСЛЕДОВАТЕЛЬНО,
     не ломая чужие данные
4. Классифицируй каждый корень:
   - test     = баг в тесте (невалидное или переименованное поле, неверный ассерт,
                недетерминизм: выбор [0] из неотсортированной выборки, повтор email)
   - backend  = баг сервера (служебное поле без права, каскад, неверный ответ) —
                потенциальный ПРОД-баг, заводить тикет
   - contract = рассинхрон спецификации и бэкенда (поле есть в одном, нет в другом)
   - flaky    = загрязнение, порядок или уникальность из-за общего окружения
                (не воспроизводится изолированно)
5. Дай fixTarget (что и где править) ЛИБО пометь, что ждёт backend-фикса.
   Не ослабляй тесты: не менять 200 -> oneOf, не удалять ассерты.

Верни СТРОГО структуру по схеме. Будь конкретен в evidence (цитата из контракта,
тела ответа, базы или лога). Confidence low, если не воспроизвёл.
`

const ROOT_SCHEMA = {
  type: 'object',
  required: ['collection', 'totalFailed', 'roots'],
  properties: {
    collection: { type: 'string' },
    totalFailed: { type: 'number' },
    summary: { type: 'string', description: 'одно предложение: суть падения коллекции' },
    roots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['symptom', 'httpCode', 'rootClass', 'rootCause', 'evidence', 'confidence'],
        properties: {
          symptom: { type: 'string', description: 'шаг + что не так, напр. "get filter by uid -> 400"' },
          httpCode: { type: 'number' },
          rootClass: { type: 'string', enum: ['test', 'backend', 'contract', 'flaky', 'unknown'] },
          rootCause: { type: 'string' },
          evidence: { type: 'string', description: 'цитата из контракта, тела ответа, базы или лога' },
          fixTarget: { type: 'string', description: 'файл и поле для правки ЛИБО "ждёт backend-фикса"' },
          backendBugSuspect: { type: 'boolean' },
          knownBug: { type: 'string', description: 'ссылка на известный корень или ""' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

// ---- Коллекции --------------------------------------------------------------
//
// `hint` — не приказ, а гипотеза: агенту прямо сказано проверить её, а не принимать
// на веру. Без подсказки агент тратит половину бюджета на то, что уже известно из
// сводки прогона; с подсказкой без оговорки — подтверждает её и останавливается.
const COLLECTIONS = [
  {
    name: 'orders-basic',
    prefix: 'orders-basic-end-point-tests',
    file: 'orders-basic-end-point-tests.json',
    hint: 'МИКС (13 фейлов, минимум 3 корня): (1) поле services удалено из контракта -> 403; '
      + '(2) get-by-uid: ассерт "expected 18 to equal 12" и отсутствие ключа на верхнем уровне; '
      + '(3) фильтр по uid -> 400. Разбери КАЖДЫЙ отдельно: тест это или контракт/бэкенд.',
  },
  {
    name: 'customers-module',
    prefix: 'customers-module-complete',
    file: 'customers-module-complete.json',
    hint: '22 фейла 422 на уникальности. Гипотеза: недетерминированный email или login '
      + 'при повторных прогонах в общем окружении. Проверь, детерминирован ли создаваемый '
      + 'идентификатор и есть ли за собой уборка.',
  },
  {
    name: 'catalog-items',
    prefix: 'catalog-items-tests',
    file: 'catalog-items-tests.json',
    hint: '9 фейлов 422 на уникальности. Проверь уникальные поля позиции каталога и cleanup.',
  },
  {
    name: 'attachments',
    prefix: 'attachments-tests',
    file: 'attachments-tests.json',
    hint: '11 фейлов 400/404/500. Разбери по телам ответов.',
  },
  {
    name: 'file-storage',
    prefix: 'file-storage-tests',
    file: 'file-storage-tests.json',
    hint: '6 фейлов. Видно: получение ссылки 422 "The key field is required" и загрузка '
      + 'большого файла 400. Проверь, передаёт ли тест key и корректен ли multipart-эндпоинт.',
  },
]

phase('Triage')
log(`Triage ${COLLECTIONS.length} коллекций по готовым отчётам`)

const results = await parallel(
  COLLECTIONS.map((c) => () =>
    agent(
      `${SHARED}\n\n===== ТВОЯ КОЛЛЕКЦИЯ =====\n`
        + `name: ${c.name}\n`
        + `отчёт: ls -1t tests/run-reports/${c.prefix}*.json | head -1\n`
        + `файл коллекции: tests/function/${c.file}\n`
        + `подсказка-гипотеза (проверь, не принимай на веру): ${c.hint}\n`,
      { label: `triage:${c.name}`, phase: 'Triage', model: 'sonnet', effort: 'medium', schema: ROOT_SCHEMA },
    ).then((r) =>
      r
        ? { ...r, _name: c.name }
        : { _name: c.name, collection: c.name, totalFailed: null, roots: [], summary: 'AGENT_FAILED' },
    ),
  ),
)

return { count: results.length, results }

// ---- Точки подстановки ------------------------------------------------------
//
// | Что                    | Сейчас (OrderShop)                  | Чем заменить                    |
// | ---------------------- | ----------------------------------- | ------------------------------- |
// | Блок ОКРУЖЕНИЕ         | localhost:3000, psql, openapi/      | своим стендом и источником схем |
// | МЕХАНИЗМ 403           | права на каждое поле payload        | своим разобранным механизмом    |
// | ИЗВЕСТНЫЕ КОРНИ        | 3 примера                           | своими; список копится по ходу  |
// | rootClass enum         | test/backend/contract/flaky/unknown | оставить как есть — см. ниже    |
// | COLLECTIONS            | 5 примеров                          | своими упавшими коллекциями     |
// | Путь к extract-failures| tools/nightly/extract-failures.js   | своим путём                     |
//
// Классификацию менять не стоит: она отвечает на вопрос «кто чинит». Без неё разбор
// сваливается в «тест упал — поправим тест», и настоящие серверные дефекты уезжают
// в продакшн под видом флаки-тестов.
