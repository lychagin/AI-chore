---
name: commit
description: Create a git commit following project Conventional Commits rules (TASK-prefixed, body in Russian)
---

# Custom Commit

Create a git commit following the project's commit message format.

## Format

```
<type>(<scope>): [TASK-XXX] <subject>

[body — на русском языке]

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Rules

### Subject line

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`
- **Scope:** optional, e.g. `backend`, `api-gateway`, `test`, `openapi`, `data-model`, `workforce`
- **Task ID:** `[TASK-XXX]` — extract number from branch name or use one provided by user
- **Subject:** English, imperative mood ("Add", "Fix"), max 72 chars, no trailing period
- **No Russian words in subject line**

### Body

- **Language: Russian** — описание что и зачем изменено
- Separate from subject by a blank line
- Each line max 99 characters
- New sentence on new line
- Max 30 lines
- Explains _what/why_, not _how_

### Footer

- `BREAKING CHANGE:` if applicable

## Steps

1. Run `git status` to see changed files (never use `-uall` flag)
2. Run `git diff` to see staged and unstaged changes
3. Run `git log --oneline -5` to see recent commit style
4. Extract TASK number from branch name (pattern: `task-XXXX` or `TASK-XXXX`)
5. Analyze all changes and draft commit message following the format above
6. Stage only relevant files by name (not `git add -A`)
7. Do NOT stage files that look like secrets (.env, credentials)
8. Create commit using HEREDOC format:

   ```bash
   git commit -m "$(cat <<'EOF'
   type(scope): [TASK-XXXX] Subject in English

   Тело коммита на русском языке.
   Описание что и зачем было изменено.

   Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
   EOF
   )"
   ```

9. Run `git status` after commit to verify success

## Examples

```
feat(orders): [TASK-1042] Add multi-criteria access filtering for orders

Реализована AND-логика проверки доступа к заказам по критериям:
регион AND категория товара AND подразделение.
Пустой критерий в группе доступа игнорируется (считается ANY).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

```
fix(test): [TASK-1042] Add deliverySlot to multi-criteria access tests

Тесты создания заказа с доставкой падали с 400, т.к. валидация
UC-2.14 требует обязательное поле deliverySlot для доставляемых категорий.

Изменения:
- Добавлен setup-шаг загрузки словаря deliverySlotDict
- В тела Create Order 1 и Create Order 2 добавлено поле deliverySlot

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```
