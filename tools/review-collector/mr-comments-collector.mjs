import { writeFileSync, readFileSync, mkdirSync, renameSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig, createGitlabClient, fetchMrDiscussions, sleep } from "./gitlab-client.mjs";

/**
 * MR Comments Collector — core module.
 *
 * Собирает комментарии из GitLab Merge Request'ов за период и сохраняет
 * в плоский JSONL формат для последующего анализа паттернов ревью.
 *
 * См. .docs/superpowers/specs/2026-04-10-gitlab-mr-comments-extractor-design.md
 */

export const SCHEMA_VERSION = "1.0";

export const DEFAULT_BOT_PATTERNS = ["*-bot", "*_bot", "ghost"];

export function globToRegex(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const withWildcard = escaped.replace(/\*/g, ".*");
    return new RegExp(`^${withWildcard}$`);
}

export function isBot(username, patterns) {
    if (!username) return false;
    return patterns.some((p) => globToRegex(p).test(username));
}

/**
 * Парсит период и возвращает {from, to} в ISO формате.
 * Поддерживаемые форматы: 3m, 30d, 1y
 *
 * @note Для месяцев (m) и лет (y) на числах >28 возможно смещение:
 *       31 марта - 1 месяц = 3 марта (JS автоматически корректирует дату).
 *       Для более точных вычислений используйте дни (30d вместо 1m).
 */
export function parsePeriod(period) {
    const match = period.match(/^(\d+)(d|m|y)$/i);
    if (!match) {
        throw new Error(`Неверный формат периода: "${period}". Ожидается: 3m, 30d, 1y`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    const to = new Date();
    const from = new Date(to);

    if (unit === "d") from.setDate(from.getDate() - value);
    else if (unit === "m") from.setMonth(from.getMonth() - value);
    else if (unit === "y") from.setFullYear(from.getFullYear() - value);

    return { from: from.toISOString(), to: to.toISOString() };
}

export function dedupeMrsByIid(mrs) {
    const seen = new Set();
    const result = [];
    for (const mr of mrs) {
        if (seen.has(mr.iid)) continue;
        seen.add(mr.iid);
        result.push(mr);
    }
    return result;
}

export function detectDiscussionKind(note) {
    if (note.type === "DiffNote") return "diff";
    if (note.position) return "diff";
    return "overview";
}

export function flattenNote(mr, discussion, note, noteIndex, projectPath, exportedAt) {
    const rootNote = discussion.notes[0];
    const isRoot = noteIndex === 0;
    const position = note.position || null;
    const discussionKind = detectDiscussionKind(note);

    return {
        schema_version: SCHEMA_VERSION,
        project_path: projectPath,

        mr_iid: mr.iid,
        mr_title: mr.title,
        mr_state: mr.state,
        mr_created_at: mr.created_at,
        mr_merged_at: mr.merged_at ?? null,
        mr_author_username: mr.author?.username ?? "",
        mr_author_name: mr.author?.name ?? "",
        mr_web_url: mr.web_url,
        mr_labels: mr.labels ?? [],

        discussion_id: discussion.id,
        discussion_kind: discussionKind,
        discussion_resolved: rootNote.resolved ?? false,
        discussion_resolved_by_username: rootNote.resolved_by?.username ?? null,
        discussion_resolved_at: rootNote.resolved_at ?? null,
        discussion_notes_count: discussion.notes.length,

        note_id: note.id,
        note_body: note.body,
        note_author_username: note.author?.username ?? "",
        note_author_name: note.author?.name ?? "",
        note_created_at: note.created_at,
        note_type: note.type ?? "Note",

        is_root_note: isRoot,
        reply_index_in_discussion: noteIndex,
        thread_root_note_id: rootNote.id,
        parent_note_id: isRoot ? null : rootNote.id,

        note_by_mr_author: note.author?.username === mr.author?.username,

        file_path: position?.new_path ?? position?.old_path ?? null,
        new_line: position?.new_line ?? null,
        old_line: position?.old_line ?? null,
        line_range_start: position?.line_range?.start?.new_line ?? position?.new_line ?? null,
        line_range_end: position?.line_range?.end?.new_line ?? position?.new_line ?? null,

        has_suggestions: (note.suggestions?.length ?? 0) > 0 || /```suggestion/.test(note.body ?? ""),

        exported_at: exportedAt,
    };
}

/**
 * Атомарная запись JSONL: сначала в .tmp, потом rename.
 * @param {string} path
 * @param {object[]} records
 */
export function writeJsonlAtomic(path, records) {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, path);
}

/**
 * Запись sidecar meta.json.
 * @param {string} path
 * @param {object} meta
 */
export function writeMeta(path, meta) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Проверяет пересечение периода [from, to] с уже существующими экспортами.
 * Читает все *.meta.json в pending/ и processed/, проверяет period_from/period_to.
 * @param {string} outputRoot - корень lifecycle (где pending/, processed/)
 * @param {string} from - ISO
 * @param {string} to - ISO
 * @returns {Array<{file: string, period_from: string, period_to: string}>}
 */
export function findOverlappingExports(outputRoot, from, to) {
    const overlaps = [];
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();

    for (const subdir of ["pending", "processed"]) {
        const dirPath = join(outputRoot, subdir);
        if (!existsSync(dirPath)) continue;

        const files = readdirSync(dirPath).filter((f) => f.endsWith(".meta.json"));
        for (const file of files) {
            const fullPath = join(dirPath, file);
            try {
                const meta = JSON.parse(readFileSync(fullPath, "utf-8"));
                if (!meta.period_from || !meta.period_to) continue;
                const existingFrom = new Date(meta.period_from).getTime();
                const existingTo = new Date(meta.period_to).getTime();
                // Пересечение: NOT (existingTo < fromMs OR existingFrom > toMs)
                if (!(existingTo < fromMs || existingFrom > toMs)) {
                    overlaps.push({
                        file: fullPath,
                        period_from: meta.period_from,
                        period_to: meta.period_to,
                    });
                }
            } catch {
                // broken meta — игнорируем
            }
        }
    }

    return overlaps;
}

/**
 * Генерирует datetime-строку для имени файла: "2026-04-10T15-00-00".
 * @returns {string}
 */
export function formatFileDateTime(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Получить список MR за период с фильтром по state.
 * Не используем fetchMrList из gitlab-client.mjs потому что он
 * хардкодит state=merged и не принимает параметр state в options.
 *
 * @param {Function} gitlabApiPaginated
 * @param {string} projectPath
 * @param {{from: string, to: string, state: string}} opts
 * @returns {Promise<object[]>}
 */
async function fetchMrListByState(gitlabApiPaginated, projectPath, { from, to, state }) {
    const params = new URLSearchParams({
        state,
        order_by: "updated_at",
        sort: "desc",
        updated_after: from,
        updated_before: to,
    });
    const endpoint = `/projects/${encodeURIComponent(projectPath)}/merge_requests?${params.toString()}`;
    return gitlabApiPaginated(endpoint);
}

/**
 * Полный пайплайн сбора комментариев из MR.
 *
 * @param {object} options
 * @param {string} options.projectPath - GitLab project path
 * @param {string} options.from - ISO дата начала
 * @param {string} options.to - ISO дата конца
 * @param {string[]} options.states - ["merged", "closed"]
 * @param {string} options.outputDir - каталог куда писать (будет создан подкаталог pending/)
 * @param {string[]} [options.botPatterns] - glob-паттерны ботов
 * @param {boolean} [options.force] - игнорировать warning о пересечении
 * @param {boolean} [options.verbose]
 * @returns {Promise<{outputPath: string, metaPath: string, stats: object, overlaps: object[]}>}
 */
export async function collectMrComments(options) {
    const {
        projectPath,
        from,
        to,
        states,
        outputDir,
        botPatterns = DEFAULT_BOT_PATTERNS,
        force = false,
        verbose = false,
    } = options;

    if (!projectPath) throw new Error("projectPath обязателен");
    if (!from || !to) throw new Error("from и to обязательны");
    if (!states || states.length === 0) throw new Error("states не может быть пустым");

    const config = loadConfig();
    if (!config.GITLAB_TOKEN) {
        throw new Error("GITLAB_TOKEN не задан. Укажите в .env или ~/.cursor/gitlab-token");
    }

    const { gitlabApiPaginated } = createGitlabClient(config.GITLAB_TOKEN, config.GITLAB_URL);

    // 1. Проверка идемпотентности
    const overlaps = findOverlappingExports(outputDir, from, to);
    if (overlaps.length > 0 && !force) {
        console.error(`[WARN] Найдены ${overlaps.length} пересекающихся экспорта:`);
        for (const o of overlaps) {
            console.error(`  ${o.file} (${o.period_from} — ${o.period_to})`);
        }
        console.error(`Используйте --force чтобы продолжить, либо удалите старые файлы.`);
        return { overlaps, cancelled: true };
    }

    // 2. Сбор MR для каждого state, дедупликация
    let allMrs = [];
    for (const state of states) {
        if (verbose) console.error(`Получение MR (state=${state})...`);
        const mrs = await fetchMrListByState(gitlabApiPaginated, projectPath, { from, to, state });
        if (verbose) console.error(`  state=${state}: ${mrs.length} MR`);
        allMrs.push(...mrs);
    }
    allMrs = dedupeMrsByIid(allMrs);
    console.error(`Найдено MR (после дедупликации): ${allMrs.length}`);

    // Оценка времени: ~0.65с на MR (эмпирически)
    const estimatedSec = Math.round(allMrs.length * 0.65);
    const estimatedMin = Math.floor(estimatedSec / 60);
    const estimatedRemSec = estimatedSec % 60;
    const estimatedStr =
        estimatedMin > 0
            ? `${estimatedMin} мин ${estimatedRemSec > 0 ? estimatedRemSec + " с" : ""}`
            : `${estimatedSec} с`;
    console.error(`Оценка времени выгрузки: ~${estimatedStr}`);

    // 3. Сбор discussions и flattening
    const exportedAt = new Date().toISOString();
    const records = [];
    const errors = [];
    const stats = {
        total_mrs_fetched: allMrs.length,
        total_discussions_fetched: 0,
        total_notes_raw: 0,
        total_notes_written: 0,
        filtered: { system: 0, bot: 0, empty: 0 },
    };

    const startTime = Date.now();
    for (let i = 0; i < allMrs.length; i++) {
        const mr = allMrs[i];

        // Progress bar (всегда, не только в verbose)
        const done = i + 1;
        const total = allMrs.length;
        const pct = Math.round((done / total) * 100);
        const barWidth = 30;
        const filled = Math.round((done / total) * barWidth);
        const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
        const elapsedSec = (Date.now() - startTime) / 1000;
        const etaSec = done > 1 ? Math.round((elapsedSec / done) * (total - done)) : null;
        const etaStr =
            etaSec !== null ? (etaSec >= 60 ? `~${Math.floor(etaSec / 60)}м ${etaSec % 60}с` : `~${etaSec}с`) : "...";
        process.stderr.write(`\r  [${bar}] ${done}/${total} (${pct}%)  осталось: ${etaStr}   `);

        if (verbose) console.error(`\n  MR !${mr.iid}: ${mr.title}`);

        try {
            const discussions = await fetchMrDiscussions(gitlabApiPaginated, projectPath, mr.iid);
            stats.total_discussions_fetched += discussions.length;

            for (const discussion of discussions) {
                if (!discussion.notes || discussion.notes.length === 0) continue;

                for (let noteIndex = 0; noteIndex < discussion.notes.length; noteIndex++) {
                    const note = discussion.notes[noteIndex];
                    stats.total_notes_raw++;

                    if (note.system === true) {
                        stats.filtered.system++;
                        continue;
                    }
                    if (isBot(note.author?.username, botPatterns)) {
                        stats.filtered.bot++;
                        continue;
                    }
                    if (!note.body || note.body.trim() === "") {
                        stats.filtered.empty++;
                        continue;
                    }

                    const record = flattenNote(mr, discussion, note, noteIndex, projectPath, exportedAt);
                    records.push(record);
                    stats.total_notes_written++;
                }
            }
        } catch (err) {
            console.error(`    [ERROR] MR !${mr.iid}: ${err.message}`);
            errors.push({ mr_iid: mr.iid, error: err.message });
        }

        if (i < allMrs.length - 1) {
            await sleep(200);
        }
    }
    process.stderr.write("\n"); // завершить строку progress bar

    // 4. Запись JSONL + meta
    const dt = formatFileDateTime();
    const pendingDir = join(outputDir, "pending");
    const outputPath = join(pendingDir, `mr-notes-${dt}.jsonl`);
    const metaPath = join(pendingDir, `mr-notes-${dt}.meta.json`);

    writeJsonlAtomic(outputPath, records);
    writeMeta(metaPath, {
        schema_version: SCHEMA_VERSION,
        project_path: projectPath,
        period_from: from,
        period_to: to,
        mr_states: states,
        generated_at: exportedAt,
        generated_by: "mr-comments-collector.mjs v1.0",
        stats,
        config: {
            bot_username_patterns: botPatterns,
        },
        errors,
    });

    console.error(`JSONL сохранён: ${outputPath}`);
    console.error(`Meta сохранена: ${metaPath}`);

    return { outputPath, metaPath, stats, overlaps: [], cancelled: false };
}

export function parseDateTimeFromFilename(filename) {
    const match = filename.match(/mr-notes-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (!match) return null;
    const [, date, hh, mm, ss] = match;
    return new Date(`${date}T${hh}:${mm}:${ss}Z`);
}

export function archiveOldProcessedFiles(outputRoot, olderThanDays, dryRun = false) {
    const processedDir = join(outputRoot, "processed");
    const archiveRoot = join(outputRoot, "archive");

    if (!existsSync(processedDir)) {
        return { moved: [], skipped: [] };
    }

    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const moved = [];
    const skipped = [];

    const files = readdirSync(processedDir).filter((f) => f.endsWith(".jsonl"));

    for (const jsonlFile of files) {
        const dt = parseDateTimeFromFilename(jsonlFile);
        if (!dt) {
            skipped.push(jsonlFile);
            continue;
        }

        if (dt.getTime() >= cutoff) {
            skipped.push(jsonlFile);
            continue;
        }

        const yyyyMm = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
        const targetDir = join(archiveRoot, yyyyMm);
        const metaFile = jsonlFile.replace(/\.jsonl$/, ".meta.json");

        const pairs = [{ from: join(processedDir, jsonlFile), to: join(targetDir, jsonlFile) }];
        if (existsSync(join(processedDir, metaFile))) {
            pairs.push({ from: join(processedDir, metaFile), to: join(targetDir, metaFile) });
        }

        if (!dryRun) {
            mkdirSync(targetDir, { recursive: true });
            for (const p of pairs) {
                renameSync(p.from, p.to);
            }
        }

        moved.push(...pairs);
    }

    return { moved, skipped };
}
