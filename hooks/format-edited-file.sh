#!/usr/bin/env bash
# PostToolUse(Edit|Write) — prettier + eslint --fix по изменённому файлу.
#
# Ключевой момент: eslint запускается из директории с БЛИЖАЙШИМ .eslintrc, а не из корня.
# В монорепозитории пакет обычно держит собственный конфиг, и корневой, применённый
# к его файлам, ломает стиль и раздувает diff.
#
# Хук никогда не должен ронять работу: любые ошибки глушатся, exit всегда 0.

set -uo pipefail

f="${CLAUDE_FILE_PATH:-}"
[ -z "$f" ] && exit 0
[ -f "$f" ] || exit 0

case "$f" in
*.ts | *.tsx | *.js | *.mjs) ;;
*) exit 0 ;;
esac

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Поиск ближайшего .eslintrc вверх по дереву — от директории файла до корня репозитория.
dir="$(cd "$(dirname "$f")" && pwd -P)"
config_dir=""
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if compgen -G "$dir/.eslintrc*" >/dev/null 2>&1 || compgen -G "$dir/eslint.config.*" >/dev/null 2>&1; then
    config_dir="$dir"
    break
  fi
  [ "$dir" = "$repo_root" ] && break
  dir="$(dirname "$dir")"
done

[ -z "$config_dir" ] && config_dir="$repo_root"

# ВАЖНО: prettier тоже запускается из config_dir, а не из корня репозитория.
# Если корневой .prettierignore исключает подпроект, запуск из корня МОЛЧА пропускает
# его файлы: ни ошибки, ни вывода, файл остаётся неотформатированным.
(cd "$config_dir" && npx prettier --write "$f" >/dev/null 2>&1)
(cd "$config_dir" && npx eslint --fix "$f" >/dev/null 2>&1)
(cd "$config_dir" && npx eslint "$f" 2>&1 | grep -E 'error|warning' | head -10) || true

exit 0
