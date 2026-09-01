#!/usr/bin/env bash
# Раскладывает артефакты AI-chore в .claude/ целевого проекта.
#
# Утилиты из tools/ намеренно НЕ устанавливаются: у каждой свой способ подключения,
# описанный в её README (npm install, регистрация MCP-сервера, права на скрипт).
#
#   ./install.sh --to /path/to/project
#   ./install.sh --to /path/to/project --dry-run
#   ./install.sh --to /path/to/project --only skills,hooks
#   ./install.sh --to /path/to/project --force

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CHORE_GROUPS=(agents commands skills hooks docs examples)

target=""
dry_run=0
force=0
only=""

die() {
  echo "ОШИБКА: $*" >&2
  exit 1
}

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo
  echo "Группы: ${CHORE_GROUPS[*]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
  --to)
    target="${2:-}"
    shift 2
    ;;
  --only)
    only="${2:-}"
    shift 2
    ;;
  --dry-run)
    dry_run=1
    shift
    ;;
  --force)
    force=1
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) die "неизвестный аргумент: $1 (--help для справки)" ;;
  esac
done

[ -n "$target" ] || {
  usage
  exit 1
}
[ -d "$target" ] || die "каталог не существует: $target"
target="$(cd "$target" && pwd -P)"
[ "$target" != "$SRC" ] || die "цель совпадает с исходным репозиторием"

# --only: проверяем имена групп до начала копирования, чтобы не разложить половину.
selected=("${CHORE_GROUPS[@]}")
if [ -n "$only" ]; then
  IFS=',' read -r -a selected <<<"$only"
  for g in "${selected[@]}"; do
    printf '%s\n' "${CHORE_GROUPS[@]}" | grep -qx "$g" || die "нет такой группы: $g (есть: ${CHORE_GROUPS[*]})"
    [ -d "$SRC/$g" ] || die "группа $g отсутствует в репозитории"
  done
fi

dest_root="$target/.claude"
echo "Источник: $SRC"
echo "Цель:     $dest_root"
[ "$dry_run" = 1 ] && echo "Режим:    ТОЛЬКО ПОКАЗ, ничего не пишется"
echo

copied=0
skipped=0
overwritten=0

for g in "${selected[@]}"; do
  echo "── $g"
  while IFS= read -r -d '' src_file; do
    rel="${src_file#"$SRC"/}"
    dst="$dest_root/$rel"

    if [ -e "$dst" ]; then
      if [ "$force" = 1 ]; then
        state="ПЕРЕЗАПИСЬ"
        overwritten=$((overwritten + 1))
      else
        echo "   пропуск (уже есть): $rel"
        skipped=$((skipped + 1))
        continue
      fi
    else
      state="новый"
      copied=$((copied + 1))
    fi

    echo "   $state: $rel"
    if [ "$dry_run" = 0 ]; then
      mkdir -p "$(dirname "$dst")"
      cp -p "$src_file" "$dst"
    fi
  done < <(find "$SRC/$g" -type f -print0 | sort -z)
done

echo
echo "Новых: $copied · перезаписано: $overwritten · пропущено: $skipped"
if [ "$skipped" -gt 0 ] && [ "$force" = 0 ]; then
  echo "Существующие файлы не тронуты. Перезаписать — повтори с --force."
fi

cat <<'NEXT'

Дальше вручную:
  1. Прочитать examples/example-project.md и заменить конкретику OrderShop на свою.
  2. Хуки подключить в .claude/settings.json (пути и события — в hooks/README.md).
  3. Утилиты из tools/ поставить отдельно, по README каждой.
NEXT
