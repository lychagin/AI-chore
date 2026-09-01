# read-bug — настройка доступов

Навык `/read-bug <id>` ходит в трекер OpenProject по REST API v3. Для работы нужны
две-три переменные в `.envrc` (в корне репозитория): URL, токен и — если инсталляция
за корпоративным TLS — путь к CA-бандлу.

---

## 1. Что прописать в `.envrc`

```bash
export OPENPROJECT_URL=https://openproject.example.com
export OPENPROJECTTOKEN=<ваш_API_токен>                      # см. раздел 2
export NODE_EXTRA_CA_CERTS="$PWD/certs/ca-bundle.pem"        # только если нужен, см. раздел 3
```

> **Важно:** direnv не доходит до инструментов Claude Code, поэтому в командах навыка
> переменные подгружаются инлайн: `source .envrc 2>/dev/null` в начале каждого bash-вызова.

Проверка, что доступ работает:

```bash
source .envrc 2>/dev/null
curl -s --max-time 30 --cacert "$NODE_EXTRA_CA_CERTS" -u "apikey:${OPENPROJECTTOKEN}" \
  "${OPENPROJECT_URL}/api/v3/work_packages/<любой существующий id>" | head -c 200
```

Должен вернуться JSON (а не пусто/ошибка TLS).

---

## 2. Как получить `OPENPROJECTTOKEN` (API-токен)

1. Залогиньтесь в свою инсталляцию OpenProject.
2. Откройте профиль → **«Моя учётная запись»** (My account).
3. В меню справа выберите **«Маркеры доступа»** (Access tokens).
4. Нажмите **«＋ Token API»** (Generate / + API token).
5. Скопируйте сгенерированный токен и вставьте в `.envrc` как `OPENPROJECTTOKEN`.

> Токен показывается один раз — сразу сохраните. Авторизация в API идёт как
> `-u "apikey:<токен>"` (Basic, логин буквально `apikey`).
>
> ⚠️ Токен — секрет. `.envrc` не коммитить (должен быть в `.gitignore`).

---

## 3. CA-сертификат (только если инсталляция за корпоративным TLS)

Если OpenProject доступен по публично доверенному сертификату, этот раздел пропусти:
переменная `NODE_EXTRA_CA_CERTS` не нужна.

Если сервер за корпоративным центром сертификации, `curl` и Node не подхватят цепочку
из системного хранилища — CA указывается явно.

Снять цепочку с сервера и сохранить промежуточный CA:

```bash
HOST=openproject.example.com
mkdir -p certs
echo | openssl s_client -connect "$HOST:443" -servername "$HOST" -showcerts 2>/dev/null \
  | openssl x509 -outform PEM > certs/ca-bundle.pem
```

Проверить содержимое:

```bash
openssl x509 -in certs/ca-bundle.pem -noout -subject -issuer
```

Альтернатива — экспортировать цепочку из браузера (значок замка → сведения
о сертификате → экспорт в Base-64 `.pem`).

> ⚠️ **`NODE_EXTRA_CA_CERTS` заменяет системные корни, а не дополняет их.** Одиночный
> сертификат в этой переменной рвёт цепочку до всех публичных сайтов
> (`unable to get issuer certificate`) — нужен полный бандл: свой CA плюс системные
> корни в одном файле.

---

## Используемые эндпоинты OpenProject API (v3)

| Назначение             | Запрос                                                                           |
| ---------------------- | -------------------------------------------------------------------------------- |
| Описание задачи        | `GET /api/v3/work_packages/<id>` (`subject`, `description.raw`, `_links.*`)      |
| Список вложений        | `GET /api/v3/work_packages/<id>/attachments` (`_embedded.elements[].fileName`)   |
| Скачать вложение       | `GET /api/v3/attachments/<attId>/content`                                        |
| Комментарии (Activity) | `GET /api/v3/work_packages/<id>/activities` (`_embedded.elements[].comment.raw`) |

---

## Точки подстановки

| Что | Сейчас | Чем заменить |
| --- | --- | --- |
| `OPENPROJECT_URL` | `openproject.example.com` | Адресом своей инсталляции |
| Идентификатор проекта | не задан в скилле | Если трекер другой — см. ниже |
| `NODE_EXTRA_CA_CERTS` | `certs/ca-bundle.pem` | Своим бандлом либо убрать переменную |

**Если трекер не OpenProject.** Скилл написан под REST API v3: структура ответа
(`_links`, `_embedded.elements`, `description.raw`) и способ авторизации
(`-u "apikey:<токен>"`) — его особенности. Под Jira или YouTrack переписываются
запросы и разбор ответа; фазы скилла (описание → скриншоты → комментарии → синтез →
вопросы при нехватке данных) переносятся без изменений.

Основной путь скилла — MCP-сервер [`mcp-openproject`](../../tools/mcp-servers/mcp-openproject/),
`curl` остаётся запасным. Если сервер поднят, ничего из перечисленного выше настраивать
не нужно — он берёт те же переменные сам.
