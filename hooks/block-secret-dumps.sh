#!/usr/bin/env bash
# PreToolUse(Bash) guard — блокирует команды, печатающие раскрытые секреты.
#
# Причина: субагент однажды выполнил `docker compose config` при проверке деплоя и
# выгрузил живой Telegram bot token прямо в транскрипт — потребовался перевыпуск токена.
#
# Контракт хуков Claude Code:
#   stdin  — JSON с полем .tool_input.command
#   exit 0 — разрешить, exit 2 — заблокировать (stderr уходит модели как объяснение)
#
# Философия: ложное срабатывание дороже пропуска, поэтому при любой неопределённости
# (не распарсился JSON, нет python3) хук пропускает команду.

set -uo pipefail

payload="$(cat)"

cmd="$(
  printf '%s' "$payload" | python3 -c 'import json, sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    print("")
' 2>/dev/null
)"

# Пусто / не распарсилось / нет python3 — не мешаем работе.
[ -z "$cmd" ] && exit 0

block() {
  printf 'Заблокировано: %s\n\n' "$1" >&2
  printf 'Правило "Секреты" из правил проекта.\n' >&2
  printf 'Безопасные альтернативы:\n' >&2
  printf '  docker compose config --no-interpolate   # без подстановки значений\n' >&2
  printf "  grep -oE '^[A-Z_]+=' .env                 # только имена ключей\n" >&2
  printf '  printenv NAME                             # конкретный ключ, если он не секрет\n' >&2
  exit 2
}

# 1. docker compose config без --no-interpolate — печатает все значения env.
if printf '%s' "$cmd" | grep -Eq 'docker[-[:space:]]+compose[[:space:]]+config' &&
  ! printf '%s' "$cmd" | grep -q -- '--no-interpolate'; then
  block 'docker compose config раскрывает значения переменных окружения'
fi

# 2. Голые env / printenv / export -p (без конкретного ключа) — дамп всего окружения.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|][[:space:]]*)(env|printenv)[[:space:]]*($|[|;&>])'; then
  block 'env/printenv без аргумента печатает всё окружение целиком'
fi

if printf '%s' "$cmd" | grep -Eq '(^|[;&|][[:space:]]*)export[[:space:]]+-p([[:space:]]|$)'; then
  block 'export -p печатает все экспортированные переменные со значениями'
fi

# 3. Чтение .env / .envrc целиком. `source .envrc` разрешён — он ничего не печатает.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|][[:space:]]*)(cat|less|more|head|tail|bat)[[:space:]]+[^|;&]*(\.env([./[:alnum:]_-]*)?|\.envrc)([[:space:]]|$)'; then
  block 'вывод .env/.envrc целиком помещает секреты в транскрипт'
fi

exit 0
