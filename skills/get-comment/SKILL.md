---
name: get-comment
description: Получить ремарки из Merge Request и сохранить в md файл для ответов
---

# Get Comments from MR

Получает все комментарии из указанного Merge Request, группирует их по приоритетам и сохраняет в файл для дальнейшей работы с ответами.

## Использование

```
/get-comment <mr_number>
```

Например: `/get-comment 1702`

## Что делает

1. Получает все комментарии (общие и inline) через MCP gitlab
2. Группирует по приоритетам (критические/важные/незначительные)
3. Сохраняет в файл `.swap/requirements/use_cases/review/mr-<number>-remarks-<datetime>.md`
4. Отображает сгруппированные ремарки на консоли

## Формат выходного файла

```markdown
# MR <number> - Ремарки review

**Дата:** YYYY-MM-DD HH:MM:SS
**Автор:** [автор общего review]

## Краткая сводка

| Приоритет         | Количество |
| ----------------- | ---------- |
| 🔴 Критические    | N          |
| 🟡 Важные         | N          |
| 🔵 Незначительные | N          |
| **Итого**         | N          |

---

## 🔴 Критические

### [discussion_id] - файл:строка

**Автор:** @username
**Создан:** YYYY-MM-DD HH:MM

**Текст:**
Содержимое комментария...

**Ответ:**

<!-- Ваш ответ здесь -->

---

## 🟡 Важные

...

## 🔵 Незначительные

...

## Общие комментарии

...
```

## Приоритеты

Комментарии автоматически определяются по тегам в теле:

- 🔴 **critical** → Критические
- 🟡 **warning** → Важные
- 🔵 **nitpick** / 💡 **suggestion** → Незначительные
- Без тега → Общие

## Шаги выполнения

1. Получить номер MR из аргументов команды
2. Вызвать `mcp__gitlab__get_mr_comments` с `mr_iid` (без `verbose=true`, чтобы не перегружать UI большим JSON)
3. Создать директорию `.swap/requirements/use_cases/review/` если не существует
4. Сгенерировать datetime для имени файла: `date +%Y-%m-%d-%H-%M-%S` (НЕ использовать node с regex!)
5. Парсить комментарии:
   - Извлечь discussion_id, author, created_at, body, position
   - Определить приоритет по тегам в body
   - Сгруппировать по приоритетам
6. Вывести на консоль сгруппированные ремарки
7. Записать в файл `.swap/requirements/use_cases/review/mr-<mr_number>-remarks-<datetime>.md`

## Пример консольного вывода

```
📋 MR 1702 - Ремарки review
Автор: @aleksandr.dmitriev

🔴 Критические (5)
  ├─ PromoCode.yaml:13 - Паттерн без учёта регистра
  ├─ PromoCodeCreateRequestBody.yaml:12 - Паттерн без учёта регистра
  ├─ PromoCode.yaml:30 - createdBy без fullName/login
  ├─ PromoCode.yaml:38 - status без name/label
  └─ 4-0010-Permissions.yaml:341 - Дублирование permissions

🟡 Важные (4)
  ├─ PromoCode.yaml:14 - Example не соответствует паттерну
  ├─ 4-0081-Permissions-orders.yaml:170 - Разный неймспейс
  ├─ promo-code.integration.spec.ts:277 - Тест не проверяет фильтрацию
  └─ user-guide.md:78 - Авто-деактивация помечена как manual

🔵 Незначительные (5)
  ├─ promo-client.ts:378 - value не валидируется
  ├─ promo-code.integration.spec.ts:8 - Привязка к внутреннему API фреймворка
  ├─ api-reference.md:211 - No newline
  ├─ user-guide.md:139 - No newline
  └─ v1_orders_promo_codes.yaml:71 - Неочевидные параметры

💾 Сохранено в: .swap/review/mr-1702-remarks-2026-03-20-143025.md
```

## Примечания

- Файл создаётся с discussion_id, что позволяет использовать его для последующих ответов
- Inline комментарии включают информацию о позиции (файл, строка)
- Системные комментарии (assigned, merge train) игнорируются
