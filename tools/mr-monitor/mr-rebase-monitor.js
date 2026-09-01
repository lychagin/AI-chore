#!/usr/bin/env node
/**
 * MR Rebase Monitor — авто-rebase GitLab MR на свежий target branch.
 *
 * Один прогон проверки: если MR open и behind target — делает rebase + force-push.
 * Запускать через cron (например, каждые 15 минут).
 *
 * Использование:
 *   node tools/mr-monitor/mr-rebase-monitor.js --mr-iid <num> [опции]
 *
 * Опции:
 *   --mr-iid <num>          GitLab MR iid (обязательно)
 *   --project-id <num>      GitLab project id или namespace/project (по умолчанию DEFAULT_PROJECT_ID из окружения)
 *   --worktree <path>       Путь к worktree с source-веткой MR
 *                           (по умолчанию — авто-detect через `git worktree list`)
 *   --main-repo <path>      Путь к основному репозиторию для fetch target-ветки
 *                           (по умолчанию MR_MONITOR_MAIN_REPO или текущий каталог)
 *   --dry-run               Не делать push, только показать что сделается
 *   --quiet                 Не выводить ничего при up-to-date состоянии
 *
 * Env:
 *   GITLAB_TOKEN            Personal access token (обязательно)
 *   GITLAB_URL              GitLab API URL, e.g. https://gitlab.example.com/api/v4 (обязательно)
 *
 * Exit codes:
 *   0   успех (rebase done, up-to-date, или merged)
 *   1   ошибка конфигурации/окружения
 *   2   rebase conflict — требуется ручное вмешательство
 *   3   push failure
 *   4   GitLab API error
 *   5   git error
 *
 * Примеры:
 *   # Базовый запуск
 *   GITLAB_TOKEN=xxx GITLAB_URL=https://gitlab.example/api/v4 \
 *     node tools/mr-monitor/mr-rebase-monitor.js --mr-iid 2119
 *
 *   # Cron entry (каждые 15 минут на :7,:22,:37,:52)
 *   7,22,37,52 * * * * cd <путь к репозиторию> && \
 *     GITLAB_TOKEN=... GITLAB_URL=... node tools/mr-monitor/mr-rebase-monitor.js \
 *     --mr-iid 2119 --quiet >> /tmp/mr-2119-monitor.log 2>&1
 */

"use strict";

const { spawnSync } = require("child_process");

// -----------------------------------------------------------------------------
// Arg parsing
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const args = {
        mrIid: null,
        projectId: process.env.DEFAULT_PROJECT_ID || "",
        worktree: null,
        mainRepo: process.env.MR_MONITOR_MAIN_REPO || process.cwd(),
        dryRun: false,
        quiet: false,
    };
    const items = argv.slice(2);
    items.forEach((arg, i) => {
        if (arg === "--mr-iid") args.mrIid = items[i + 1];
        if (arg === "--project-id") args.projectId = items[i + 1];
        if (arg === "--worktree") args.worktree = items[i + 1];
        if (arg === "--main-repo") args.mainRepo = items[i + 1];
        if (arg === "--dry-run") args.dryRun = true;
        if (arg === "--quiet") args.quiet = true;
        if (arg === "--help" || arg === "-h") {
            console.log(readDocComment());
            process.exit(0);
        }
    });
    if (!args.mrIid) {
        console.error("ERROR: --mr-iid is required");
        process.exit(1);
    }
    return args;
}

function readDocComment() {
    // Возвращает usage из верхнего docblock этого файла
    try {
        const fs = require("fs");
        const src = fs.readFileSync(__filename, "utf8");
        const m = src.match(/\/\*\*([\s\S]*?)\*\//);
        return m
            ? m[1]
                  .split("\n")
                  .map((l) => l.replace(/^\s*\*\s?/, ""))
                  .join("\n")
            : "see source";
    } catch {
        return "see source for usage";
    }
}

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

let QUIET = false;

function logInfo(msg) {
    if (!QUIET) console.log(`[INFO] ${msg}`);
}
function logWarn(msg) {
    console.warn(`[WARN] ${msg}`);
}
function logError(msg) {
    console.error(`[ERROR] ${msg}`);
}

// -----------------------------------------------------------------------------
// GitLab API
// -----------------------------------------------------------------------------

function checkEnv() {
    if (!process.env.GITLAB_TOKEN) {
        logError("GITLAB_TOKEN env var is not set");
        process.exit(1);
    }
    if (!process.env.GITLAB_URL) {
        logError("GITLAB_URL env var is not set");
        process.exit(1);
    }
}

async function fetchMrInfo(projectId, mrIid) {
    const url = `${process.env.GITLAB_URL}/projects/${projectId}/merge_requests/${mrIid}`;
    const res = await fetch(url, {
        headers: { "PRIVATE-TOKEN": process.env.GITLAB_TOKEN },
    });
    if (!res.ok) {
        logError(`GitLab API ${res.status}: ${res.statusText}`);
        process.exit(4);
    }
    return res.json();
}

// -----------------------------------------------------------------------------
// Git helpers
// -----------------------------------------------------------------------------

function gitExec(cwd, args, opts = {}) {
    const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        ...opts,
    });
    if (result.status !== 0 && !opts.allowFailure) {
        logError(`git ${args.join(" ")} (exit ${result.status})`);
        if (result.stdout) logError(`stdout: ${result.stdout.trim()}`);
        if (result.stderr) logError(`stderr: ${result.stderr.trim()}`);
        process.exit(5);
    }
    return result;
}

function findWorktree(mainRepo, sourceBranch) {
    const res = gitExec(mainRepo, ["worktree", "list", "--porcelain"]);
    // Парсим porcelain output: блоки строк "worktree <path>", "HEAD <sha>", "branch refs/heads/<name>"
    const blocks = res.stdout.split(/\n\n+/);
    const items = blocks.map((block) => {
        const lines = block.split("\n");
        const out = {};
        lines.forEach((line) => {
            const [key, ...rest] = line.split(" ");
            if (key === "worktree") out.path = rest.join(" ");
            if (key === "branch") out.branch = rest.join(" ").replace(/^refs\/heads\//, "");
        });
        return out;
    });
    const match = items.find((w) => w.branch === sourceBranch);
    return match ? match.path : null;
}

// -----------------------------------------------------------------------------
// Main flow
// -----------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv);
    QUIET = args.quiet;

    checkEnv();

    logInfo(`Checking MR !${args.mrIid} (project ${args.projectId})`);

    // 1. Fetch MR info
    const mr = await fetchMrInfo(args.projectId, args.mrIid);
    const sourceBranch = mr.source_branch;
    const targetBranch = mr.target_branch;
    const state = mr.state;

    logInfo(`MR state: ${state}, source: ${sourceBranch}, target: ${targetBranch}`);

    // 2. Handle terminal states
    if (state === "merged") {
        if (!args.quiet) console.log(`✅ MR !${args.mrIid} is MERGED — nothing to do`);
        process.exit(0);
    }
    if (state === "closed") {
        if (!args.quiet) console.log(`⛔ MR !${args.mrIid} is CLOSED — nothing to do`);
        process.exit(0);
    }
    if (state !== "opened") {
        logWarn(`Unknown MR state '${state}' — skipping`);
        process.exit(0);
    }

    // 3. Fetch target branch in main repo
    logInfo(`Fetching origin/${targetBranch} in ${args.mainRepo}`);
    gitExec(args.mainRepo, ["fetch", "origin", targetBranch]);

    // 4. Resolve worktree
    let worktree = args.worktree;
    if (!worktree) {
        worktree = findWorktree(args.mainRepo, sourceBranch);
        if (!worktree) {
            logError(`No worktree found for branch '${sourceBranch}' in ${args.mainRepo}`);
            logError(`Hint: create worktree first: git worktree add <path> ${sourceBranch}`);
            process.exit(1);
        }
        logInfo(`Auto-detected worktree: ${worktree}`);
    }

    // 5. Compare merge-base vs origin/target
    const targetSha = gitExec(args.mainRepo, ["rev-parse", `origin/${targetBranch}`]).stdout.trim();
    const mergeBase = gitExec(args.mainRepo, ["merge-base", `origin/${targetBranch}`, sourceBranch], {
        allowFailure: true,
    });

    if (mergeBase.status !== 0) {
        logError(`Cannot compute merge-base — does branch '${sourceBranch}' exist locally?`);
        process.exit(5);
    }

    const baseSha = mergeBase.stdout.trim();
    if (baseSha === targetSha) {
        if (!args.quiet) {
            logInfo(`MR !${args.mrIid} is UP-TO-DATE with origin/${targetBranch} (${targetSha.slice(0, 9)})`);
        }
        process.exit(0);
    }

    logInfo(`MR !${args.mrIid} needs rebase:`);
    logInfo(`  merge-base:        ${baseSha.slice(0, 9)}`);
    logInfo(`  origin/${targetBranch}: ${targetSha.slice(0, 9)}`);

    // 6. Discard known junk in worktree (package-lock.json auto-formatter)
    const status = gitExec(worktree, ["status", "--porcelain"]);
    const dirtyFiles = status.stdout.trim().split("\n").filter(Boolean);
    const knownJunk = ["package-lock.json"];
    knownJunk.forEach((file) => {
        const isDirty = dirtyFiles.some((line) => line.includes(file));
        if (isDirty) {
            logInfo(`Discarding junk: ${file}`);
            if (!args.dryRun) {
                gitExec(worktree, ["checkout", "HEAD", "--", file]);
            }
        }
    });

    // Check for other unstaged modifications — abort if present (safety)
    const remainingDirty = gitExec(worktree, ["status", "--porcelain"])
        .stdout.trim()
        .split("\n")
        .filter(Boolean)
        .filter((line) => !line.startsWith("??")); // ignore untracked
    if (remainingDirty.length > 0) {
        logError(`Worktree has uncommitted modifications — aborting:`);
        remainingDirty.forEach((line) => logError(`  ${line}`));
        process.exit(5);
    }

    if (args.dryRun) {
        logInfo("DRY RUN — would rebase + force-push");
        process.exit(0);
    }

    // 7. Rebase
    logInfo(`Rebasing onto origin/${targetBranch}...`);
    const rebase = gitExec(worktree, ["rebase", `origin/${targetBranch}`], { allowFailure: true });
    if (rebase.status !== 0) {
        logError(`Rebase failed (likely conflicts):`);
        logError(rebase.stdout.trim());
        logError(rebase.stderr.trim());
        logError(`Aborting rebase to leave clean state...`);
        gitExec(worktree, ["rebase", "--abort"], { allowFailure: true });
        logError(`⚠️  MR !${args.mrIid}: REBASE CONFLICT — manual resolution required.`);
        logError(`    Worktree: ${worktree}`);
        logError(`    Branch:   ${sourceBranch}`);
        logError(`    Target:   origin/${targetBranch}`);
        process.exit(2);
    }
    logInfo("Rebase OK");

    // 8. Force-push
    logInfo(`Pushing to origin/${sourceBranch} (--force-with-lease)...`);
    const push = spawnSync(
        "timeout",
        ["180", "git", "push", "--no-verify", "--force-with-lease", "origin", sourceBranch],
        { cwd: worktree, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    if (push.status !== 0) {
        logError(`Push failed (exit ${push.status})`);
        if (push.stdout) logError(`stdout: ${push.stdout.trim()}`);
        if (push.stderr) logError(`stderr: ${push.stderr.trim()}`);
        process.exit(3);
    }

    const newHead = gitExec(worktree, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    console.log(
        `✅ MR !${args.mrIid}: rebased on origin/${targetBranch} (${targetSha.slice(0, 9)}), force-push OK → ${newHead}`,
    );
    process.exit(0);
}

main().catch((err) => {
    logError(`Uncaught: ${err.stack || err}`);
    process.exit(1);
});
