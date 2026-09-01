---
name: mine-patterns
description: Synthesize review patterns from processed GitLab MR comments. Runs CLI preprocessor, then two-pass LLM analysis to produce review-patterns.json and review-patterns.md.
---

# Mine Patterns Skill

You are orchestrating the Pattern Mining pipeline for the Review Collector project.
Working directory is the root of the review-collector project.

## Overview

Two-pass synthesis:

- **Pass 1:** Read `patterns/threads.jsonl` in chunks of 30 threads → extract raw patterns → accumulate in `patterns/mining-state.json`
- **Pass 2:** Read all raw patterns from `patterns/mining-state.json` → deduplicate, generalize, finalize → write `patterns/review-patterns.json` + `patterns/review-patterns.md`

---

## Step 1: Run preprocessor

Run:

```bash
node preprocess-comments.mjs
```

Read the output:

- If output is "No new files to process." → no `.jsonl` files in `review/raw/pending/`, skip Pass 1, go directly to Pass 2
- If output starts with "Processed" → files have been moved to `review/raw/processed/`, note how many threads were written, proceed to Pass 1
- If it exits with an error → stop and report the error to the user

---

## Step 2: Pass 1 — Raw pattern extraction (chunk by chunk)

Read `patterns/threads.jsonl`. Each line is a JSON thread object.

Process in chunks of 30 threads at a time. For each chunk, analyze using this prompt:

---

You are a senior code reviewer analyzing a batch of code review discussions from GitLab MRs.

Each thread below is a review discussion: a reviewer's comment (root_comment) and optionally the author's replies.

Your task: extract review patterns — rules that, if followed, would prevent these issues.

IMPORTANT:

- Synthesize a rule even from a single comment. Do not require repetition.
- Be specific and actionable: "Always set HTTP timeout explicitly" not "Be careful with HTTP"
- Each pattern must have: title, category, rule, evidence (1-2 quotes from the actual comments), frequency (count of threads supporting it in this chunk)

Categories: robustness, security, performance, style, architecture, testing

Threads:
[Include the 30 thread objects here as a JSON array]

Respond ONLY with a JSON array:
[
{
"id": "rp_NNN",
"title": "...",
"category": "robustness",
"rule": "...",
"evidence": ["quote from thread root_comment or replies"],
"source_discussions": ["discussion_id"],
"frequency": 1
}
]

---

After each chunk:

1. Parse the JSON response
2. Read current `patterns/mining-state.json`
3. Assign sequential IDs to new patterns continuing from the last existing ID (rp_001, rp_002, ...)
4. Append new raw patterns to `raw_patterns[]`
5. Write updated `patterns/mining-state.json`
6. Report progress: "Chunk N/M complete — X raw patterns total so far"

---

## Step 3: Pass 2 — Finalization

Read `patterns/mining-state.json` and check `raw_patterns`. If the array is empty, stop and report:
"No patterns to finalize. Add `.jsonl` files to `review/raw/pending/` and re-run `/mine-patterns`."

Otherwise, read all `raw_patterns` and proceed.

Analyze them with this prompt:

---

You are a senior code reviewer. Below are raw review patterns extracted from GitLab MR discussions.

Your task: produce a clean, deduplicated final list of review patterns.

Rules:

- Merge patterns that describe the same issue (even if worded differently)
- Sum frequencies of merged patterns
- Keep the most general and actionable formulation
- Assign priority: high (frequent ≥5 or security/critical), medium (2-4 occurrences), low (1 occurrence, minor)
- Assign final IDs: p_001, p_002, ...
- Sort by priority (high first), then by category

Raw patterns:
[Include the full raw_patterns array here]

Respond ONLY with a JSON object:
{
"patterns": [
{
"id": "p_001",
"title": "...",
"category": "robustness",
"priority": "high",
"rule": "...",
"rationale": "...",
"example_comments": ["quote from evidence"],
"frequency": 5,
"last_seen": "<today's date in YYYY-MM-DD format>"
}
]
}

---

After receiving the response:

**Write `patterns/review-patterns.json`:**

```json
{
  "schema_version": "1.0",
  "generated_at": "<current ISO timestamp>",
  "patterns": [ ...patterns from response... ]
}
```

**Write `patterns/review-patterns.md`** — generate from the JSON, grouped by category, sorted by priority within each category:

```markdown
# Review Patterns

_Generated: <date>. Total: N patterns._

---

## <category>

### <id> · <title>

**Правило:** <rule>
**Почему:** <rationale>
**Встречалось:** <frequency> раз
**Пример:** "<first example_comment>"

---
```

---

## Step 4: Report to user

```
Pattern mining complete.

Pass 1: N threads processed, M raw patterns extracted
Pass 2: K final patterns (deduplicated from M raw)

Output files:
  patterns/review-patterns.json  — machine-readable (for Reviewer Agent)
  patterns/review-patterns.md    — human-readable

Top patterns by priority:
  high: X
  medium: Y
  low: Z
```

Ask: "Would you like to review the patterns in `patterns/review-patterns.md`?"
