#!/usr/bin/env node

/**
 * CLI для сбора комментариев из GitLab MR в плоский JSONL формат.
 *
 * Использование:
 *   node collect-mr-comments.mjs [options]
 *   node collect-mr-comments.mjs archive [--older-than 30d] [--dry-run]
 */

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    collectMrComments,
    archiveOldProcessedFiles,
    parsePeriod,
    DEFAULT_BOT_PATTERNS,
} from "./mr-comments-collector.mjs";
import { loadConfig } from "./gitlab-client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function showHelp() {
    console.log(`
GitLab MR Comments Collector

Использование:
  node collect-mr-comments.mjs [options]
  node collect-mr-comments.mjs archive [--older-than 30d] [--dry-run]

Опции сбора:
  --period <value>    Период: 3m, 30d, 1y (по умолчанию: 3m)
  --from <ISO>        Начало периода (альтернатива --period)
  --to <ISO>          Конец периода (по умолчанию: сейчас)
  --project <path>    GitLab project path (по умолчанию: из .env)
  --states <list>     Comma-separated: merged,closed (по умолчанию)
  --output <path>     Путь к JSONL (переопределяет lifecycle дефолт)
  --force             Игнорировать warning о пересекающемся периоде
  --verbose           Подробный лог
  --help              Показать эту справку

Подкоманда archive:
  --older-than <value>  Архивировать processed файлы старше N дней (default: 30d)
  --dry-run             Показать что будет перемещено, ничего не делать

Примеры:
  node collect-mr-comments.mjs
  node collect-mr-comments.mjs --period 6m --verbose
  node collect-mr-comments.mjs --from 2026-01-01 --to 2026-03-31 --force
  node collect-mr-comments.mjs archive --older-than 60d --dry-run
`);
}

function getOutputRoot() {
    // Проект живёт в отдельном репозитории — сохраняем в review/raw/ рядом со скриптом
    return join(__dirname, "review", "raw");
}

function parseBotPatternsFromEnv() {
    const raw = process.env.BOT_USERNAME_PATTERNS;
    if (!raw) return DEFAULT_BOT_PATTERNS;
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseOlderThanDays(value) {
    const match = value.match(/^(\d+)d?$/);
    if (!match) throw new Error(`Неверный формат --older-than: "${value}". Ожидается число или Nd.`);
    return parseInt(match[1], 10);
}

async function runCollect(args) {
    // Загружаем .env через loadConfig (это populates process.env)
    const config = loadConfig();

    let from, to;
    if (args.from || args.to) {
        if (!args.from) {
            console.error("Ошибка: --from обязателен при указании --to");
            process.exit(1);
        }
        from = new Date(args.from).toISOString();
        to = args.to ? new Date(args.to).toISOString() : new Date().toISOString();
    } else {
        const period = args.period || "3m";
        ({ from, to } = parsePeriod(period));
    }

    const statesStr = args.states || "merged,closed";
    const states = statesStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const projectPath = args.project || config.DEFAULT_PROJECT_ID;
    if (!projectPath) {
        console.error("Ошибка: project path не задан (используйте --project или DEFAULT_PROJECT_ID в .env)");
        process.exit(1);
    }

    const outputDir = args.output ? dirname(args.output) : getOutputRoot();
    const botPatterns = parseBotPatternsFromEnv();

    if (args.verbose) {
        console.error(`Проект: ${projectPath}`);
        console.error(`Период: ${from} — ${to}`);
        console.error(`States: ${states.join(", ")}`);
        console.error(`Output: ${outputDir}`);
        console.error(`Bot patterns: ${botPatterns.join(", ")}`);
    }

    const result = await collectMrComments({
        projectPath,
        from,
        to,
        states,
        outputDir,
        botPatterns,
        force: args.force,
        verbose: args.verbose,
    });

    if (result.cancelled) {
        process.exit(2);
    }

    console.log(`\nГотово!`);
    console.log(`  MR:              ${result.stats.total_mrs_fetched}`);
    console.log(`  Discussions:     ${result.stats.total_discussions_fetched}`);
    console.log(`  Notes raw:       ${result.stats.total_notes_raw}`);
    console.log(`  Notes written:   ${result.stats.total_notes_written}`);
    console.log(`  Filtered system: ${result.stats.filtered.system}`);
    console.log(`  Filtered bot:    ${result.stats.filtered.bot}`);
    console.log(`  Filtered empty:  ${result.stats.filtered.empty}`);
    console.log(`  JSONL:           ${result.outputPath}`);
    console.log(`  Meta:            ${result.metaPath}`);
}

function runArchive(args) {
    const olderThan = args["older-than"] ? parseOlderThanDays(args["older-than"]) : 30;
    const dryRun = args["dry-run"] === true;

    const outputRoot = getOutputRoot();
    console.error(`Архивация processed файлов старше ${olderThan} дней в ${outputRoot}/archive/YYYY-MM/`);
    if (dryRun) console.error(`(DRY RUN — ничего не меняется)`);

    const result = archiveOldProcessedFiles(outputRoot, olderThan, dryRun);

    console.log(`Перемещено файлов: ${result.moved.length}`);
    for (const m of result.moved) {
        console.log(`  ${m.from} → ${m.to}`);
    }
    console.log(`Пропущено: ${result.skipped.length}`);
}

async function main() {
    const rawArgs = process.argv.slice(2);

    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
        showHelp();
        process.exit(0);
    }

    // Определяем подкоманду
    const subcommand = rawArgs[0] && !rawArgs[0].startsWith("--") ? rawArgs[0] : null;

    if (subcommand === "archive") {
        const { values } = parseArgs({
            args: rawArgs.slice(1),
            options: {
                "older-than": { type: "string" },
                "dry-run": { type: "boolean", default: false },
            },
            allowPositionals: false,
        });
        runArchive(values);
        return;
    }

    // Основной сбор
    const { values } = parseArgs({
        args: rawArgs,
        options: {
            period: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            project: { type: "string" },
            states: { type: "string" },
            output: { type: "string" },
            force: { type: "boolean", default: false },
            verbose: { type: "boolean", default: false },
        },
        allowPositionals: false,
    });

    try {
        await runCollect(values);
    } catch (err) {
        if (err.cause?.code === "ECONNREFUSED" || err.cause?.code === "ENOTFOUND" || err.message === "fetch failed") {
            const gitlabUrl = process.env.GITLAB_URL ?? "(не задан в .env)";
            console.error(`\nОшибка: не удалось подключиться к GitLab (${gitlabUrl})`);
            console.error("Проверь: доступна ли сеть, нужен ли VPN, правильный ли GITLAB_URL в .env");
        } else {
            console.error(`\nОшибка: ${err.message}`);
        }
        if (values.verbose) console.error(err.stack);
        process.exit(1);
    }
}

main();
