# HOW-TO: Review Collector

Пошаговое руководство по использованию инструмента.

---

## Содержание

1. [Первичная настройка](#1-первичная-настройка)
2. [Сбор комментариев из GitLab](#2-сбор-комментариев-из-gitlab)
3. [Анализ паттернов ревью](#3-анализ-паттернов-ревью)
4. [Ревью своих коммитов](#4-ревью-своих-коммитов)
5. [Обслуживание](#5-обслуживание)

---

## 1. Первичная настройка

### Шаг 1. Клонируй репозиторий

```bash
git clone git@github.com:lychagin/review-collector.git
cd review-collector
```

### Шаг 2. Создай файл конфигурации

```bash
cp .env.example .env
```

### Шаг 3. Заполни `.env`

```env
GITLAB_TOKEN=your_gitlab_token_here
GITLAB_URL=https://your-gitlab.example.com/api/v4
DEFAULT_PROJECT_ID=your-group/your-project
```

Токен создаётся в GitLab: **Settings → Access Tokens → read_api**.

### Шаг 4. Проверь что Node.js установлен

```bash
node --version
# Требуется Node.js 20+
```

---

## 2. Сбор комментариев из GitLab

Запусти сбор комментариев из MR за нужный период:

```bash
# За последние 3 месяца (по умолчанию)
node collect-mr-comments.mjs

# За последние 6 месяцев
node collect-mr-comments.mjs --period 6m

# За конкретный период
node collect-mr-comments.mjs --from 2026-01-01 --to 2026-03-31

# Другой проект (не DEFAULT_PROJECT_ID из .env)
node collect-mr-comments.mjs --period 3m --project other-group/other-repo

# Посмотреть прогресс в реальном времени
node collect-mr-comments.mjs --verbose
```

**Результат** сохраняется в `review/raw/pending/`:

```
review/raw/
  pending/
    mr-notes-2026-04-12T10-30-00.jsonl      ← данные
    mr-notes-2026-04-12T10-30-00.meta.json  ← метаданные
```

**Справка по всем опциям:**

```bash
node collect-mr-comments.mjs --help
```

---

## 3. Анализ паттернов ревью

После сбора данных запусти анализ через Claude Code.

### Шаг 1. Открой Claude Code в директории проекта

```bash
claude
```

### Шаг 2. Запусти скилл

```
/mine-patterns
```

Скилл выполнит два прохода:

- **Проход 1** — препроцессор читает файлы из `pending/`, перемещает в `processed/`, извлекает треды
- **Проход 2** — LLM анализирует треды и синтезирует финальные паттерны

**Результат** — два файла:

```
patterns/
  review-patterns.json  ← machine-readable (используется при ревью коммитов)
  review-patterns.md    ← human-readable (прочитай сам)
```

### Шаг 3. Просмотри паттерны

```bash
cat patterns/review-patterns.md
```

---

## 4. Ревью своих коммитов

После того как паттерны собраны, можно проверять свои коммиты.

### Шаг 1. Открой Claude Code в директории проекта

```bash
claude
```

### Шаг 2. Запусти ревью

```
# Последний коммит
/review-commits HEAD

# Последние 3 коммита
/review-commits HEAD~3

# Конкретный диапазон
/review-commits abc123..def456
```

Скилл покажет только нарушения паттернов — код который не соответствует правилам, выработанным на основе реальных ревью.

**Отчёт** сохраняется в `review/reports/`.

---

## 5. Обслуживание

### Архивирование старых данных

```bash
# Показать что будет перемещено (ничего не трогает)
node collect-mr-comments.mjs archive --older-than 30d --dry-run

# Переместить в archive/YYYY-MM/
node collect-mr-comments.mjs archive --older-than 30d
```

### Повторный сбор за тот же период

```bash
node collect-mr-comments.mjs --period 3m --force
```

### Повторный запуск анализа паттернов

Просто положи новые `.jsonl` файлы в `review/raw/pending/` и запусти `/mine-patterns` снова. Скилл добавит новые паттерны к существующим.

---

## Типичный рабочий цикл

```
1. Раз в месяц:
   node collect-mr-comments.mjs --period 1m
   → /mine-patterns

2. Перед пушем:
   → /review-commits HEAD~N
   → исправить нарушения
   → пуш
```
