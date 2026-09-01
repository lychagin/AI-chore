---
name: review-commits
description: Проверить локальные коммиты по накопленной базе паттернов ревью и показать только нарушения. Вызывать перед push, чтобы не отдавать на ревью то, что уже ловили раньше.
---

# Review Commits Skill

You are orchestrating the Review Commits pipeline for the Review Collector project.
Working directory is the root of the review-collector project.

## Purpose

Check local git commits against the pattern base and report only violations.
Main use case: verify your own commits before pushing.

---

## Step 1: Parse the argument

The skill is invoked as `/review-commits <arg>` where `<arg>` is optional.

**If no argument was given:** Ask the user: "Which commits should I review? (e.g. `HEAD~3`, a SHA, or `abc..def`)"

**If an argument was given**, determine the git ref:

| Input example                            | Git ref to use                                     |
| ---------------------------------------- | -------------------------------------------------- |
| `HEAD~3`, `HEAD~1`                       | Use as-is → becomes `HEAD~3..HEAD` in get-diff.mjs |
| `abc123` (40- or 7-char SHA)             | Use as-is                                          |
| `abc123..def456`                         | Use as-is                                          |
| `HEAD`                                   | Use as-is                                          |
| "последние 3 коммита", "last 3 commits"  | → `HEAD~3`                                         |
| "последний коммит", "last commit"        | → `HEAD`                                           |
| "последние N коммитов", "last N commits" | → `HEAD~N`                                         |

---

## Step 2: Get the diff

Determine the repo root: it is the current working directory (where Claude Code is running).

Run:

```bash
node review-collector/get-diff.mjs --repo <repo-root> <git-ref>
```

Where `<repo-root>` is the absolute path to the project root. Example:

```bash
node review-collector/get-diff.mjs --repo /home/user/my-project HEAD~3
```

Read the JSON from stdout. It has the shape:

```json
{
  "commits": [{ "sha": "abc1234", "message": "...", "author": "..." }],
  "diff": "<unified diff>",
  "files_changed": ["src/foo.ts"]
}
```

If the command exits with code 1, stop and report the error to the user.

If Node.js reports "Cannot find module", stop with: `get-diff.mjs not found. Check that review-collector is installed in the project root.`

**IMPORTANT: Do not run any additional git commands during analysis.** All information needed (commits, diff, changed files) is already in the JSON output above. Never use `cd && git` — if you absolutely must run git, use `git -C <repo-root>` instead.

---

## Step 3: Check patterns file

Read `patterns/review-patterns.json`.

If the file does not exist, stop with:

> "Patterns not found. Run `/mine-patterns` first."

---

## Step 4: Identify relevant patterns

Look at the diff and the list of changed files. Select the patterns from `review-patterns.json` that are plausibly applicable to this diff.

Criteria for inclusion — include a pattern if ANY of:

- The pattern's `category` matches something visible in the diff (e.g. a pattern about `security` is worth checking whenever credentials, tokens, or auth logic appear)
- Keywords in the pattern's `rule` or `title` match identifiers, function names, or concepts visible in the diff
- The pattern describes a type of code structure that is present (e.g. pagination params, HTTP calls, database queries)

You do NOT need to apply every pattern. Skip patterns that are clearly irrelevant to the changed code.

---

## Step 5: Analyse the diff against selected patterns

For each selected pattern, examine the diff carefully. A violation exists when the diff introduces or modifies code that breaks the pattern's `rule`.

**Only flag actual violations** — do not flag code that is unchanged, and do not flag theoretical risks.

For each violation, note:

- Pattern ID and title
- The file path and line number from the nearest `@@` hunk header above the violation (this is the hunk start line, not the exact line)
- The specific code fragment that violates the rule (copy from the `+` lines in the diff)
- A concise explanation of why it violates the pattern

---

## Step 6: Compose the report

Determine the short SHA: use the first SHA from `commits[0].sha` (7 chars).
Determine the commit count label:

- 1 commit → `"<sha> (1 commit)"`
- N commits → `"<first-sha>..<last-sha> (N commits)"`

`<first-sha>` = `commits[0].sha` (7 chars). `<last-sha>` = `commits[commits.length - 1].sha` (7 chars).

### If violations found:

```markdown
# Code Review Report

**Commits:** <label>
**Date:** <YYYY-MM-DD>

---

## <pattern-id> · <pattern-title>

**Файл:** `<file-path>:<line>`
**Фрагмент:** `<code snippet from diff>`
**Проблема:** <concise explanation>

---

## <next pattern-id> · <next pattern-title>

...
```

### If no violations:

```markdown
# Code Review Report

**Commits:** <label>
**Date:** <YYYY-MM-DD>

---

✅ Нарушений паттернов не найдено.
```

**Date** is today's date in YYYY-MM-DD format (not the commit date).

---

## Step 7: Save the report

Save the report to:

```
review/reports/<YYYY-MM-DD>-<short-sha>.md
```

`<short-sha>` is always `commits[0].sha` (7 chars) — the earliest commit in the range.

Create the `review/reports/` directory if it doesn't exist (use the Bash tool: `mkdir -p review/reports`).

Write the file using the Write tool.

---

## Step 8: Output to terminal

Print the full report to the terminal (output it as your response text).

Then print:

```
Report saved: review/reports/<YYYY-MM-DD>-<short-sha>.md
```
