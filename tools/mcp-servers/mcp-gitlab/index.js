#!/usr/bin/env node

/**
 * MCP Server for GitLab MR Comments
 *
 * Транспорт: stdio (JSON-RPC 2.0 через stdin/stdout).
 * Запуск: через launcher .cursor/mcp-gitlab-launcher.mjs или напрямую node index.js.
 *
 * Источники токена (приоритет по убыванию):
 *   1. GITLAB_TOKEN в окружении процесса (CI, export)
 *   2. .env файл рядом с index.js
 *   3. ~/.cursor/gitlab-token (одна строка)
 *
 * Переменные окружения:
 *   GITLAB_TOKEN          — GitLab PAT (обязательный)
 *   GITLAB_URL            — base URL API, включая /api/v4 (обязательный)
 *   DEFAULT_PROJECT_ID    — проект по умолчанию, `namespace/name` или числовой ID
 *                           (необязательный: без него project_id указывается в каждом вызове)
 *   GITLAB_TIMEOUT_MS     — таймаут запроса к GitLab, мс (default: 10000)
 *
 * Отладочные переменные (подробнее в README):
 *   MCP_DEBUG             — включить логирование в stderr + файл (default: false)
 *   MCP_DEBUG_SLOW_MS     — порог "медленного" вызова, мс (default: 1000)
 *   MCP_DEBUG_LOG_FILE    — путь к лог-файлу (default: /tmp/gitlab-mcp.log)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";

// Load .env file manually
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadEnv() {
    try {
        const envPath = resolve(__dirname, ".env");
        const envContent = readFileSync(envPath, "utf-8");
        envContent.split("\n").forEach((line) => {
            const [key, ...valueParts] = line.split("=");
            const value = valueParts.join("=").trim();
            if (key && !key.startsWith("#") && value) {
                process.env[key] = value;
            }
        });
    } catch (err) {
        if (err?.code === "ENOENT") {
            console.error("Warning: .env file not found");
            return;
        }
        throw err;
    }
}

/**
 * Читает .envrc из корня репозитория — direnv до MCP-процесса не доходит,
 * поэтому при запуске без экспортированных переменных сервер брал бы токен ниоткуда.
 * Значения, уже пришедшие из окружения, не перетираются.
 * Глубина 8: из git worktree до корня основного чекаута дальше, чем 4 уровня.
 */
function loadRepoEnvrc() {
    let dir = __dirname;
    for (let depth = 0; depth < 8; depth += 1) {
        const candidate = join(dir, ".envrc");
        try {
            const lines = readFileSync(candidate, "utf-8").split("\n");
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || line.startsWith("#")) continue;
                const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
                if (!match) continue;
                const [, key, rawValue] = match;
                if (process.env[key]) continue;
                const unquoted = rawValue
                    .trim()
                    .replace(/^"(.*)"$/s, "$1")
                    .replace(/^'(.*)'$/s, "$1");
                // $PWD в .envrc direnv трактует как каталог файла; у MCP-процесса cwd другой
                const value = unquoted.replace(
                    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
                    (match_, braced, bare) => {
                        const name = braced || bare;
                        if (name === "PWD") return dir;
                        return process.env[name] ?? match_;
                    },
                );
                if (value) process.env[key] = value;
            }
            return candidate;
        } catch (err) {
            if (err?.code !== "ENOENT") {
                console.error(`Warning: не удалось прочитать ${candidate}: ${err.message}`);
            }
        }
        const parent = resolve(dir, "..");
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** Значение GITLAB_TOKEN из окружения родителя (CI и т.п.) не перезаписываем из .env */
const presetGitlabToken = process.env.GITLAB_TOKEN;
loadEnv();
if (presetGitlabToken) {
    process.env.GITLAB_TOKEN = presetGitlabToken;
}
loadGitlabTokenFromHomeFile();
loadRepoEnvrc();

function loadGitlabTokenFromHomeFile() {
    if (process.env.GITLAB_TOKEN) {
        return;
    }
    try {
        const tokenPath = join(homedir(), ".cursor", "gitlab-token");
        const raw = readFileSync(tokenPath, "utf-8").trim();
        if (raw) {
            process.env.GITLAB_TOKEN = raw;
        }
    } catch {
        // файл отсутствует — норма, токен из .env или CI
    }
}

const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
// Умолчания намеренно отсутствуют: адрес чужого GitLab в дефолте даёт при опечатке
// в конфиге не понятную ошибку, а запросы не туда.
const GITLAB_URL = process.env.GITLAB_URL;
const DEFAULT_PROJECT_ID = process.env.DEFAULT_PROJECT_ID || "";
const GITLAB_TIMEOUT_MS = Number(process.env.GITLAB_TIMEOUT_MS || 10000);
const MCP_DEBUG = ["1", "true", "yes", "on"].includes(String(process.env.MCP_DEBUG || "").toLowerCase());
const MCP_DEBUG_SLOW_MS = Number(process.env.MCP_DEBUG_SLOW_MS || 1000);
const MCP_DEBUG_LOG_FILE = process.env.MCP_DEBUG_LOG_FILE || "/tmp/gitlab-mcp.log";

function logError(message) {
    console.error(message);
    if (!MCP_DEBUG) {
        return;
    }
    try {
        appendFileSync(MCP_DEBUG_LOG_FILE, `${message}\n`, "utf8");
    } catch {
        // ignore file logging errors to keep MCP server alive
    }
}

if (!GITLAB_TOKEN) {
    logError("Error: GITLAB_TOKEN environment variable is not set.");
    process.exit(1);
}

if (!GITLAB_URL) {
    logError("Error: GITLAB_URL is not set. Example: GITLAB_URL=https://gitlab.example.com/api/v4");
    process.exit(1);
}

logError(`gitlab-mcp running (GitLab: ${GITLAB_URL}, default project: ${DEFAULT_PROJECT_ID || "<не задан>"})`);
if (MCP_DEBUG) {
    logError(`[mcp-debug] enabled (timeout=${GITLAB_TIMEOUT_MS}ms, log_file=${MCP_DEBUG_LOG_FILE})`);
}

function debugLog(event, payload = {}) {
    if (!MCP_DEBUG) {
        return;
    }
    const ts = new Date().toISOString();
    logError(`[mcp-debug] ${ts} ${event} ${JSON.stringify(payload)}`);
}

function debugSlow(event, elapsedMs, payload = {}) {
    if (!MCP_DEBUG || !Number.isFinite(MCP_DEBUG_SLOW_MS)) {
        return;
    }
    if (elapsedMs < MCP_DEBUG_SLOW_MS) {
        return;
    }
    const ts = new Date().toISOString();
    logError(
        `[mcp-debug][slow] ${ts} ${event} ${JSON.stringify({ elapsed_ms: elapsedMs, threshold_ms: MCP_DEBUG_SLOW_MS, ...payload })}`,
    );
}

function redactArgs(args = {}) {
    let body = args.body;
    if (typeof args.body === "string") {
        const suffix = args.body.length > 120 ? "..." : "";
        body = `${args.body.slice(0, 120)}${suffix}`;
    }
    return {
        ...args,
        body,
        body_length: typeof args.body === "string" ? args.body.length : undefined,
    };
}

function responsePayloadSize(responsePayload) {
    try {
        return Buffer.byteLength(JSON.stringify(responsePayload), "utf8");
    } catch {
        return -1;
    }
}

/** Методы, для которых обрыв связи оставляет состояние на сервере неизвестным */
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * Превращает сетевую ошибку fetch в сообщение, по которому видно:
 *   1) что именно случилось (таймаут / нет связи / DNS);
 *   2) применилась ли операция на сервере — для мутаций это неизвестно.
 *
 * Без этого агент видит голое "fetch failed" и вслепую повторяет запрос,
 * создавая дубли MR и комментариев.
 */
function describeNetworkError(error, method, endpoint) {
    const verb = method || "GET";
    const unknownState = MUTATING_METHODS.includes(verb)
        ? " Состояние на сервере НЕИЗВЕСТНО: перечитай список MR/комментариев перед повтором, иначе получится дубль."
        : "";

    if (error?.name === "TimeoutError") {
        return new Error(`GitLab: таймаут ${GITLAB_TIMEOUT_MS}мс на ${verb} ${endpoint}.${unknownState}`);
    }

    const code = error?.cause?.code || error?.code;
    const networkCodes = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"];
    if (networkCodes.includes(code)) {
        return new Error(
            `GitLab недоступен (${code}) на ${verb} ${endpoint} — вероятно выключен VPN.${unknownState}`,
        );
    }

    const certCodes = ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED"];
    if (certCodes.includes(code)) {
        return new Error(
            `GitLab: не проверяется сертификат (${code}) на ${verb} ${endpoint}. ` +
                "MCP-процессу нужен NODE_EXTRA_CA_CERTS с корпоративным CA.",
        );
    }

    return new Error(`GitLab: сбой запроса ${verb} ${endpoint}: ${error?.message || String(error)}.${unknownState}`);
}

// Simple fetch wrapper for GitLab API
async function gitlabApi(endpoint, options = {}) {
    const url = `${GITLAB_URL}${endpoint}`;
    const startedAt = Date.now();
    const headers = {
        "PRIVATE-TOKEN": GITLAB_TOKEN,
        ...options.headers,
    };

    // Добавляем Content-Type только для POST/PUT запросов
    if (options.method && ["POST", "PUT", "PATCH"].includes(options.method)) {
        headers["Content-Type"] = "application/json";
    }

    let response;
    try {
        debugLog("gitlab_api_request", {
            endpoint,
            method: options.method || "GET",
            timeout_ms: GITLAB_TIMEOUT_MS,
        });
        response = await fetch(url, {
            ...options,
            headers,
            signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
        });
    } catch (error) {
        debugLog("gitlab_api_network_error", {
            endpoint,
            method: options.method || "GET",
            code: error?.cause?.code || error?.code || error?.name,
            elapsed_ms: Date.now() - startedAt,
        });
        throw describeNetworkError(error, options.method, endpoint);
    }

    if (!response.ok) {
        const error = await response.text();
        debugLog("gitlab_api_error", {
            endpoint,
            method: options.method || "GET",
            status: response.status,
            elapsed_ms: Date.now() - startedAt,
            response_bytes: Buffer.byteLength(error, "utf8"),
        });
        debugSlow("gitlab_api_error", Date.now() - startedAt, {
            endpoint,
            method: options.method || "GET",
            status: response.status,
        });
        const method = options.method || "GET";
        // 5xx на мутации: запрос мог примениться до сбоя — повтор вслепую даёт дубль
        const unknownState =
            response.status >= 500 && MUTATING_METHODS.includes(method)
                ? " Состояние на сервере НЕИЗВЕСТНО: проверь результат перед повтором."
                : "";
        throw new Error(`GitLab API error (${response.status}) на ${method} ${endpoint}: ${error}${unknownState}`);
    }

    // Для пустого ответа возвращаем null
    const contentType = response.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
        const text = await response.text();
        debugLog("gitlab_api_response", {
            endpoint,
            method: options.method || "GET",
            status: response.status,
            elapsed_ms: Date.now() - startedAt,
            content_type: contentType || "none",
            response_bytes: Buffer.byteLength(text || "", "utf8"),
        });
        debugSlow("gitlab_api_response", Date.now() - startedAt, {
            endpoint,
            method: options.method || "GET",
            status: response.status,
        });
        return text ? JSON.parse(text) : null;
    }

    const json = await response.json();
    debugLog("gitlab_api_response", {
        endpoint,
        method: options.method || "GET",
        status: response.status,
        elapsed_ms: Date.now() - startedAt,
        content_type: contentType,
        response_bytes: Buffer.byteLength(JSON.stringify(json), "utf8"),
    });
    debugSlow("gitlab_api_response", Date.now() - startedAt, {
        endpoint,
        method: options.method || "GET",
        status: response.status,
    });
    return json;
}

function normalizeMrIid(mr_iid) {
    if (typeof mr_iid !== "number" && typeof mr_iid !== "string") {
        throw new TypeError("mr_iid must be a number or string");
    }
    return String(mr_iid);
}

function normalizeDiscussionId(discussion_id) {
    if (typeof discussion_id !== "string" && typeof discussion_id !== "number") {
        throw new TypeError("discussion_id must be a string or number");
    }
    return String(discussion_id);
}

/**
 * Извлекает активные комментарии из сырого ответа GitLab /discussions.
 *
 * Пропускает:
 *   - resolved discussions (d.resolved = true)
 *   - resolved notes внутри нерезолвед-discussion (n.resolved = true)
 *   - системные notes — события pipeline, merge, push и т.п. (n.system = true)
 *
 * Разделяет на:
 *   - general  — комментарии без привязки к коду (n.position отсутствует)
 *   - inline   — комментарии к конкретной строке файла (n.position присутствует)
 */
function collectMrComments(discussions) {
    const generalComments = [];
    const inlineComments = [];
    let notesTotal = 0;
    let notesSkippedResolved = 0;
    let notesSkippedSystem = 0;

    for (const d of discussions) {
        if (d.resolved) continue;

        for (const n of d.notes) {
            notesTotal += 1;
            if (n.resolved) {
                notesSkippedResolved += 1;
                continue;
            }
            if (n.system) {
                notesSkippedSystem += 1;
                continue;
            }

            const comment = {
                id: n.id,
                discussion_id: d.id,
                author: n.author?.username || n.author?.name || "Unknown",
                body: n.body,
                created_at: n.created_at,
            };

            if (n.position) {
                inlineComments.push({
                    ...comment,
                    file: n.position.new_path,
                    line: n.position.new_line,
                    line_range: n.position.line_range,
                });
            } else {
                generalComments.push(comment);
            }
        }
    }

    return {
        generalComments,
        inlineComments,
        notesTotal,
        notesSkippedResolved,
        notesSkippedSystem,
    };
}

// Количество inline комментариев в preview (остальные — только в JSON-файле)
const INLINE_PREVIEW_LIMIT = 5;
// Максимальная длина тела комментария в compact summary
const BODY_PREVIEW_LENGTH = 300;
// Файлы старше TTL удаляются при следующем вызове get_mr_comments
const TEMP_FILE_TTL_MS = 30 * 60 * 1000;
// Префикс позволяет удалять только свои файлы, не трогая чужой tmpdir
const TEMP_FILE_PREFIX = "mcp-gitlab-mr-";

function cleanupOldTempFiles() {
    const dir = tmpdir();
    const now = Date.now();
    let removed = 0;
    try {
        const entries = readdirSync(dir);
        for (const name of entries) {
            if (!name.startsWith(TEMP_FILE_PREFIX)) continue;
            const filePath = join(dir, name);
            try {
                const { mtimeMs } = statSync(filePath);
                if (now - mtimeMs > TEMP_FILE_TTL_MS) {
                    rmSync(filePath, { force: true });
                    removed += 1;
                }
            } catch {
                // file may have been deleted by another process — ignore
            }
        }
    } catch {
        // tmpdir not readable — ignore
    }
    if (removed > 0) {
        debugLog("temp_files_cleanup", { removed, ttl_ms: TEMP_FILE_TTL_MS, dir });
    }
}

function truncateBody(body, limit = BODY_PREVIEW_LENGTH) {
    if (!body || body.length <= limit) return body;
    return `${body.slice(0, limit)}… [truncated, ${body.length} chars total]`;
}

function buildCompactSummaryText({
    generalComments,
    inlineComments,
    dumpFile,
    notesSkippedResolved,
    notesSkippedSystem,
}) {
    const lines = [];
    const total = generalComments.length + inlineComments.length;

    lines.push(
        `MR Comments: ${total} active (${generalComments.length} general, ${inlineComments.length} inline)`,
        `Skipped: ${notesSkippedResolved} resolved, ${notesSkippedSystem} system`,
        `Full JSON saved to: ${dumpFile}`,
        "",
    );

    if (generalComments.length > 0) {
        lines.push("=== General Comments ===");
        for (const c of generalComments) {
            lines.push(`[${c.discussion_id}] @${c.author}: ${truncateBody(c.body)}`);
        }
        lines.push("");
    }

    if (inlineComments.length > 0) {
        lines.push("=== Inline Comments ===");
        const preview = inlineComments.slice(0, INLINE_PREVIEW_LIMIT);
        for (const c of preview) {
            lines.push(`[${c.discussion_id}] ${c.file}:${c.line ?? "?"} @${c.author}: ${truncateBody(c.body)}`);
        }
        if (inlineComments.length > INLINE_PREVIEW_LIMIT) {
            lines.push(
                `… and ${inlineComments.length - INLINE_PREVIEW_LIMIT} more inline comments (see full JSON file)`,
            );
        }
    }

    return lines.join("\n");
}

async function handleGetMrComments(args) {
    const startedAt = Date.now();
    const { project_id, mr_iid } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const mrIid = normalizeMrIid(mr_iid);
    const endpoint = `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions`;

    debugLog("get_mr_comments_stage_start", {
        mr_iid: mrIid,
        project_id: projectId,
    });

    const discussions = await gitlabApi(endpoint);
    const afterFetchAt = Date.now();
    debugLog("get_mr_comments_stage_fetch_done", {
        mr_iid: mrIid,
        discussions_count: Array.isArray(discussions) ? discussions.length : -1,
        fetch_ms: afterFetchAt - startedAt,
    });

    const { generalComments, inlineComments, notesTotal, notesSkippedResolved, notesSkippedSystem } =
        collectMrComments(discussions);
    const afterTransformAt = Date.now();
    debugLog("get_mr_comments_stage_transform_done", {
        mr_iid: mrIid,
        transform_ms: afterTransformAt - afterFetchAt,
        notes_total: notesTotal,
        notes_skipped_resolved: notesSkippedResolved,
        notes_skipped_system: notesSkippedSystem,
        general_count: generalComments.length,
        inline_count: inlineComments.length,
    });

    const result = {
        summary: {
            total: generalComments.length + inlineComments.length,
            general: generalComments.length,
            inline: inlineComments.length,
        },
        general_comments: generalComments,
        inline_comments: inlineComments,
    };

    // Save full payload to temp file — sending large JSON over stdio causes
    // Cursor UI freezes. os.tmpdir() is cross-platform (Linux/Mac/Windows).
    cleanupOldTempFiles();
    const dumpFile = join(tmpdir(), `${TEMP_FILE_PREFIX}${mrIid}-${Date.now()}.json`);
    const fullJson = JSON.stringify(result, null, 2);
    const responseBytes = Buffer.byteLength(fullJson, "utf8");

    let dumpOk = false;
    try {
        writeFileSync(dumpFile, fullJson, "utf8");
        dumpOk = true;
        debugLog("get_mr_comments_dump_written", {
            mr_iid: mrIid,
            path: dumpFile,
            response_bytes: responseBytes,
            total_ms: Date.now() - startedAt,
        });
    } catch (err) {
        debugLog("get_mr_comments_dump_failed", {
            mr_iid: mrIid,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    let text;
    if (dumpOk) {
        text = buildCompactSummaryText({
            generalComments,
            inlineComments,
            dumpFile,
            notesSkippedResolved,
            notesSkippedSystem,
        });
    } else {
        // Fallback: return full JSON if file write failed (better than no data)
        text = fullJson;
    }

    debugLog("get_mr_comments_stage_done", {
        mr_iid: mrIid,
        dump_ok: dumpOk,
        response_bytes: responseBytes,
        summary_bytes: Buffer.byteLength(text, "utf8"),
        total_ms: Date.now() - startedAt,
    });

    return {
        content: [{ type: "text", text }],
    };
}

async function handleAddMrComment(args) {
    const { project_id, mr_iid, body } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const mrIid = normalizeMrIid(mr_iid);
    const note = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`, {
        method: "POST",
        body: JSON.stringify({ body }),
    });

    return {
        content: [{ type: "text", text: `Комментарий добавлен:\n${JSON.stringify(note, null, 2)}` }],
    };
}

async function handleAddMrDiffComment(args) {
    const { project_id, mr_iid, body, file_path, line_number, base_sha, head_sha, start_sha } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const mrIid = normalizeMrIid(mr_iid);
    const position = {
        base_sha,
        head_sha,
        start_sha: start_sha || base_sha,
        position_type: "text",
        new_path: file_path,
        old_path: file_path,
        new_line: line_number,
    };

    const discussion = await gitlabApi(
        `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions`,
        {
            method: "POST",
            body: JSON.stringify({ body, position }),
        },
    );

    return {
        content: [{ type: "text", text: `Diff-комментарий добавлен:\n${JSON.stringify(discussion, null, 2)}` }],
    };
}

async function handleResolveMrDiscussion(args) {
    const { project_id, mr_iid, discussion_id } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const mrIid = normalizeMrIid(mr_iid);
    const discussionId = normalizeDiscussionId(discussion_id);
    const result = await gitlabApi(
        `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions/${discussionId}`,
        {
            method: "PUT",
            body: JSON.stringify({ resolved: true }),
        },
    );

    return {
        content: [{ type: "text", text: `Discussion помечен как решённый:\n${JSON.stringify(result, null, 2)}` }],
    };
}

async function handleReplyToDiscussion(args) {
    const { project_id, mr_iid, discussion_id, body } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const mrIid = normalizeMrIid(mr_iid);
    const discussionId = normalizeDiscussionId(discussion_id);
    const note = await gitlabApi(
        `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
        {
            method: "POST",
            body: JSON.stringify({ body }),
        },
    );

    return {
        content: [
            { type: "text", text: `Ответ добавлен к discussion ${discussionId}:\n${JSON.stringify(note, null, 2)}` },
        ],
    };
}

async function handleGetMrInfo(args) {
    const { project_id, mr_iid } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const mrIid = normalizeMrIid(mr_iid);
    const mr = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`);

    const info = {
        iid: mr.iid,
        title: mr.title,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        web_url: mr.web_url,
        diff_refs: {
            base_sha: mr.diff_refs?.base_sha,
            head_sha: mr.diff_refs?.head_sha,
            start_sha: mr.diff_refs?.start_sha,
        },
    };

    return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
    };
}

// --- Merge requests: список, создание, обновление, изменения ------------------

/** Длина описания, после которой оно уезжает в файл, а не в ответ */
const DESCRIPTION_INLINE_LIMIT = 2000;

function textResult(text) {
    return { content: [{ type: "text", text }] };
}

/**
 * Сохраняет крупную полезную нагрузку во временный файл и отдаёт путь.
 * Ответы MCP уходят в контекст модели целиком, поэтому сырой JSON diff'а
 * или длинное описание тикета возвращать нельзя.
 */
function dumpToTempFile(prefix, payload) {
    try {
        const file = join(tmpdir(), `${prefix}${Date.now()}.json`);
        writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
        return file;
    } catch (err) {
        debugLog("temp_dump_failed", { prefix, error: err instanceof Error ? err.message : String(err) });
        return null;
    }
}

function formatMrLine(mr) {
    return `!${mr.iid} [${mr.state}] ${mr.title} — ${mr.source_branch} → ${mr.target_branch}\n  ${mr.web_url}`;
}

async function findOpenMrForBranch(projectId, sourceBranch) {
    const query = new URLSearchParams({
        source_branch: sourceBranch,
        state: "opened",
        per_page: "20",
    });
    const list = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/merge_requests?${query}`);
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

async function handleListMrs(args) {
    const { project_id, source_branch, target_branch, state = "opened", search, per_page = 20 } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const query = new URLSearchParams({ state, per_page: String(per_page) });
    if (source_branch) query.set("source_branch", source_branch);
    if (target_branch) query.set("target_branch", target_branch);
    if (search) query.set("search", search);

    const list = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/merge_requests?${query}`);
    if (!Array.isArray(list) || list.length === 0) {
        return textResult("Merge request'ов по фильтру не найдено");
    }

    return textResult([`Найдено MR: ${list.length}`, "", ...list.map(formatMrLine)].join("\n"));
}

async function handleCreateMr(args) {
    const {
        project_id,
        source_branch,
        target_branch = "develop",
        title,
        description = "",
        squash = true,
        remove_source_branch = true,
        labels,
        assignee_id,
    } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;

    // Защита от дубля: после обрыва связи агент не знает, создался ли MR
    const existing = await findOpenMrForBranch(projectId, source_branch);
    if (existing) {
        return textResult(
            [
                `MR для ветки ${source_branch} уже существует — новый НЕ создан.`,
                formatMrLine(existing),
                "",
                "Если нужно изменить заголовок или описание — используй update_mr.",
            ].join("\n"),
        );
    }

    const payload = {
        source_branch,
        target_branch,
        title,
        description,
        squash,
        remove_source_branch,
    };
    if (labels) payload.labels = Array.isArray(labels) ? labels.join(",") : labels;
    if (assignee_id) payload.assignee_id = assignee_id;

    const mr = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/merge_requests`, {
        method: "POST",
        body: JSON.stringify(payload),
    });

    return textResult(
        [
            "MR создан.",
            formatMrLine(mr),
            `squash=${mr.squash}, remove_source_branch=${mr.force_remove_source_branch ?? remove_source_branch}`,
            "Напоминание: при squash финальный commit берётся из заголовка MR — он обязан проходить commitlint.",
        ].join("\n"),
    );
}

async function handleUpdateMr(args) {
    const { project_id, mr_iid, title, description, state_event, target_branch, labels, squash, remove_source_branch } =
        args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const mrIid = normalizeMrIid(mr_iid);

    const payload = {};
    if (title !== undefined) payload.title = title;
    if (description !== undefined) payload.description = description;
    if (state_event !== undefined) payload.state_event = state_event;
    if (target_branch !== undefined) payload.target_branch = target_branch;
    if (labels !== undefined) payload.labels = Array.isArray(labels) ? labels.join(",") : labels;
    if (squash !== undefined) payload.squash = squash;
    if (remove_source_branch !== undefined) payload.remove_source_branch = remove_source_branch;

    if (Object.keys(payload).length === 0) {
        throw new Error("update_mr: не передано ни одного изменяемого поля");
    }

    const mr = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`, {
        method: "PUT",
        body: JSON.stringify(payload),
    });

    return textResult([`MR обновлён (${Object.keys(payload).join(", ")}).`, formatMrLine(mr)].join("\n"));
}

function summarizeChange(change) {
    const diff = typeof change.diff === "string" ? change.diff : "";
    let added = 0;
    let removed = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
        if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    const flags = [
        change.new_file ? "new" : null,
        change.deleted_file ? "deleted" : null,
        change.renamed_file ? "renamed" : null,
    ].filter(Boolean);
    const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    return `${change.new_path}${suffix}: +${added}/-${removed}`;
}

async function handleGetMrChanges(args) {
    const { project_id, mr_iid } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const mrIid = normalizeMrIid(mr_iid);
    const mr = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/changes`);
    const changes = Array.isArray(mr.changes) ? mr.changes : [];

    const dumpFile = dumpToTempFile(`mcp-gitlab-mr-${mrIid}-changes-`, mr.changes ?? []);
    const lines = [
        `MR !${mr.iid}: ${mr.title}`,
        `${mr.source_branch} → ${mr.target_branch}, файлов изменено: ${changes.length}`,
        dumpFile ? `Полный diff: ${dumpFile}` : "Полный diff сохранить не удалось (см. debug-лог)",
        "",
        ...changes.map(summarizeChange),
    ];
    if (mr.overflow) {
        lines.push("", "ВНИМАНИЕ: GitLab обрезал список изменений (overflow=true) — смотри diff локально через git.");
    }

    return textResult(lines.join("\n"));
}

// --- Issues -------------------------------------------------------------------

function formatIssueLine(issue) {
    const labels = issue.labels?.length ? ` [${issue.labels.join(", ")}]` : "";
    return `#${issue.iid} [${issue.state}] ${issue.title}${labels}`;
}

async function handleGetIssue(args) {
    const { project_id, issue_iid } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const issue = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/issues/${Number(issue_iid)}`);

    const description = issue.description || "";
    const lines = [
        formatIssueLine(issue),
        `Автор: ${issue.author?.username || "?"}, исполнители: ${
            issue.assignees?.map((a) => a.username).join(", ") || "нет"
        }`,
        `Milestone: ${issue.milestone?.title || "нет"}, обновлён: ${issue.updated_at}`,
        issue.web_url,
        "",
    ];

    if (description.length > DESCRIPTION_INLINE_LIMIT) {
        const dumpFile = dumpToTempFile(`mcp-gitlab-issue-${issue.iid}-`, { description });
        lines.push(
            description.slice(0, DESCRIPTION_INLINE_LIMIT),
            "",
            `… описание обрезано (${description.length} символов).` +
                (dumpFile ? ` Полный текст: ${dumpFile}` : " Сохранить полный текст не удалось."),
        );
    } else {
        lines.push(description || "(описание пустое)");
    }

    return textResult(lines.join("\n"));
}

async function handleListIssues(args) {
    const { project_id, labels, state = "opened", search, milestone, per_page = 30 } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const query = new URLSearchParams({ state, per_page: String(per_page) });
    if (labels) query.set("labels", Array.isArray(labels) ? labels.join(",") : labels);
    if (search) query.set("search", search);
    if (milestone) query.set("milestone", milestone);

    const list = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/issues?${query}`);
    if (!Array.isArray(list) || list.length === 0) {
        return textResult("Issues по фильтру не найдено");
    }

    return textResult([`Найдено issues: ${list.length}`, "", ...list.map(formatIssueLine)].join("\n"));
}

async function handleCreateIssue(args) {
    const { project_id, title, description = "", labels, milestone_id, assignee_ids } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;

    const payload = { title, description };
    if (labels) payload.labels = Array.isArray(labels) ? labels.join(",") : labels;
    if (milestone_id) payload.milestone_id = milestone_id;
    if (assignee_ids) payload.assignee_ids = assignee_ids;

    const issue = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/issues`, {
        method: "POST",
        body: JSON.stringify(payload),
    });

    return textResult(["Issue создан.", formatIssueLine(issue), issue.web_url].join("\n"));
}

async function handleUpdateIssue(args) {
    const { project_id, issue_iid, title, description, labels, add_labels, remove_labels, state_event } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;

    const payload = {};
    if (title !== undefined) payload.title = title;
    if (description !== undefined) payload.description = description;
    if (labels !== undefined) payload.labels = Array.isArray(labels) ? labels.join(",") : labels;
    if (add_labels !== undefined) payload.add_labels = Array.isArray(add_labels) ? add_labels.join(",") : add_labels;
    if (remove_labels !== undefined) {
        payload.remove_labels = Array.isArray(remove_labels) ? remove_labels.join(",") : remove_labels;
    }
    if (state_event !== undefined) payload.state_event = state_event;

    if (Object.keys(payload).length === 0) {
        throw new Error("update_issue: не передано ни одного изменяемого поля");
    }

    const issue = await gitlabApi(`/projects/${encodeURIComponent(projectId)}/issues/${Number(issue_iid)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
    });

    return textResult([`Issue обновлён (${Object.keys(payload).join(", ")}).`, formatIssueLine(issue)].join("\n"));
}

// --- Pipelines ----------------------------------------------------------------

async function handleGetPipelineStatus(args) {
    const { project_id, mr_iid, ref } = args;
    const projectId = project_id ?? DEFAULT_PROJECT_ID;
    const base = `/projects/${encodeURIComponent(projectId)}`;

    let pipelines;
    if (mr_iid !== undefined && mr_iid !== null) {
        pipelines = await gitlabApi(`${base}/merge_requests/${normalizeMrIid(mr_iid)}/pipelines`);
    } else if (ref) {
        pipelines = await gitlabApi(`${base}/pipelines?${new URLSearchParams({ ref, per_page: "1" })}`);
    } else {
        throw new Error("get_pipeline_status: укажи mr_iid или ref (имя ветки)");
    }

    if (!Array.isArray(pipelines) || pipelines.length === 0) {
        return textResult("Пайплайнов не найдено");
    }

    const latest = pipelines[0];
    const lines = [
        `Pipeline #${latest.id}: ${latest.status} (ref ${latest.ref}, sha ${String(latest.sha).slice(0, 8)})`,
        latest.web_url,
    ];

    if (["failed", "canceled"].includes(latest.status)) {
        const jobs = await gitlabApi(`${base}/pipelines/${latest.id}/jobs?scope[]=failed&per_page=20`);
        if (Array.isArray(jobs) && jobs.length > 0) {
            lines.push("", `Упавшие job'ы (${jobs.length}):`);
            for (const job of jobs) {
                lines.push(`  ${job.stage}/${job.name}: ${job.status} — ${job.web_url}`);
            }
        }
    }

    return textResult(lines.join("\n"));
}

async function withToolDebug(name, args, handler) {
    const startedAt = Date.now();
    try {
        debugLog("tool_call_start", {
            tool: name,
            args: redactArgs(args ?? {}),
        });
        const result = await handler();
        debugLog("tool_call_success", {
            tool: name,
            elapsed_ms: Date.now() - startedAt,
            response_bytes: responsePayloadSize(result),
        });
        debugSlow("tool_call", Date.now() - startedAt, { tool: name });
        return result;
    } catch (error) {
        debugLog("tool_call_error", {
            tool: name,
            elapsed_ms: Date.now() - startedAt,
            error: error?.message || String(error),
        });
        debugSlow("tool_call_error", Date.now() - startedAt, { tool: name });
        return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
        };
    }
}

const server = new McpServer({
    name: "gitlab-mcp",
    version: "1.0.0",
});

server.registerTool(
    "get_mr_comments",
    {
        description:
            "Получить все комментарии (общие и inline) из Merge Request. Если project_id не указан — используется DEFAULT_PROJECT_ID из окружения",
        inputSchema: z.object({
            project_id: z.union([z.number(), z.string()]).optional(),
            mr_iid: z.number(),
            // accepted for backward compat but ignored — compact summary is always returned
            verbose: z.boolean().optional(),
        }),
    },
    async (args) => withToolDebug("get_mr_comments", args, async () => handleGetMrComments(args)),
);

server.registerTool(
    "add_mr_comment",
    {
        description:
            "Добавить общий комментарий к Merge Request. Если project_id не указан — используется DEFAULT_PROJECT_ID из окружения",
        inputSchema: z.object({
            project_id: z.union([z.number(), z.string()]).optional(),
            mr_iid: z.number(),
            body: z.string(),
        }),
    },
    async (args) => withToolDebug("add_mr_comment", args, async () => handleAddMrComment(args)),
);

server.registerTool(
    "add_mr_diff_comment",
    {
        description:
            "Добавить комментарий к конкретной строке в diff Merge Request. Если project_id не указан — используется DEFAULT_PROJECT_ID из окружения",
        inputSchema: z.object({
            project_id: z.union([z.number(), z.string()]).optional(),
            mr_iid: z.number(),
            body: z.string(),
            file_path: z.string(),
            line_number: z.number(),
            base_sha: z.string(),
            head_sha: z.string(),
            start_sha: z.string().optional(),
        }),
    },
    async (args) => withToolDebug("add_mr_diff_comment", args, async () => handleAddMrDiffComment(args)),
);

server.registerTool(
    "resolve_mr_discussion",
    {
        description:
            "Отметить discussion как решённый (resolved). Если project_id не указан — используется DEFAULT_PROJECT_ID из окружения",
        inputSchema: z.object({
            project_id: z.union([z.number(), z.string()]).optional(),
            mr_iid: z.number(),
            discussion_id: z.string(),
        }),
    },
    async (args) => withToolDebug("resolve_mr_discussion", args, async () => handleResolveMrDiscussion(args)),
);

server.registerTool(
    "reply_to_discussion",
    {
        description: "Ответить на discussion (нить обсуждения). Используйте discussion_id из get_mr_comments.",
        inputSchema: z.object({
            project_id: z.union([z.number(), z.string()]).optional(),
            mr_iid: z.number(),
            discussion_id: z.string(),
            body: z.string(),
        }),
    },
    async (args) => withToolDebug("reply_to_discussion", args, async () => handleReplyToDiscussion(args)),
);

server.registerTool(
    "get_mr_info",
    {
        description:
            "Получить информацию о MR (включая SHA для diff комментариев). Если project_id не указан — используется DEFAULT_PROJECT_ID из окружения",
        inputSchema: z.object({
            project_id: z.union([z.number(), z.string()]).optional(),
            mr_iid: z.number(),
        }),
    },
    async (args) => withToolDebug("get_mr_info", args, async () => handleGetMrInfo(args)),
);

const projectIdSchema = z.union([z.number(), z.string()]).optional();
const labelsSchema = z.union([z.string(), z.array(z.string())]).optional();

server.registerTool(
    "list_mrs",
    {
        description:
            "Список Merge Request'ов проекта с фильтрами. Обязателен после обрыва связи на создании MR — " +
            "проверяет, создался ли MR, вместо повторной попытки вслепую",
        inputSchema: z.object({
            project_id: projectIdSchema,
            source_branch: z.string().optional(),
            target_branch: z.string().optional(),
            state: z.enum(["opened", "closed", "merged", "locked", "all"]).optional(),
            search: z.string().optional(),
            per_page: z.number().optional(),
        }),
    },
    async (args) => withToolDebug("list_mrs", args, async () => handleListMrs(args)),
);

server.registerTool(
    "create_mr",
    {
        description:
            "Создать Merge Request. Если по этой ветке уже есть открытый MR — вернёт его и НЕ создаст второй. " +
            "Ветка должна быть запушена. Заголовок обязан проходить commitlint: <type>(<scope>): [TASK-XXX] <subject>",
        inputSchema: z.object({
            project_id: projectIdSchema,
            source_branch: z.string(),
            target_branch: z.string().optional(),
            title: z.string(),
            description: z.string().optional(),
            squash: z.boolean().optional(),
            remove_source_branch: z.boolean().optional(),
            labels: labelsSchema,
            assignee_id: z.number().optional(),
        }),
    },
    async (args) => withToolDebug("create_mr", args, async () => handleCreateMr(args)),
);

server.registerTool(
    "update_mr",
    {
        description: "Обновить Merge Request: заголовок, описание, целевую ветку, метки, закрыть или переоткрыть",
        inputSchema: z.object({
            project_id: projectIdSchema,
            mr_iid: z.number(),
            title: z.string().optional(),
            description: z.string().optional(),
            state_event: z.enum(["close", "reopen"]).optional(),
            target_branch: z.string().optional(),
            labels: labelsSchema,
            squash: z.boolean().optional(),
            remove_source_branch: z.boolean().optional(),
        }),
    },
    async (args) => withToolDebug("update_mr", args, async () => handleUpdateMr(args)),
);

server.registerTool(
    "get_mr_changes",
    {
        description:
            "Список изменённых файлов MR со статистикой строк; полный diff сохраняется во временный файл, " +
            "а не отдаётся в ответ",
        inputSchema: z.object({
            project_id: projectIdSchema,
            mr_iid: z.number(),
        }),
    },
    async (args) => withToolDebug("get_mr_changes", args, async () => handleGetMrChanges(args)),
);

server.registerTool(
    "get_issue",
    {
        description: "Получить issue по номеру: заголовок, состояние, метки, исполнители, описание",
        inputSchema: z.object({
            project_id: projectIdSchema,
            issue_iid: z.union([z.number(), z.string()]),
        }),
    },
    async (args) => withToolDebug("get_issue", args, async () => handleGetIssue(args)),
);

server.registerTool(
    "list_issues",
    {
        description: "Список issues с фильтрами по меткам, состоянию, milestone и поисковой строке",
        inputSchema: z.object({
            project_id: projectIdSchema,
            labels: labelsSchema,
            state: z.enum(["opened", "closed", "all"]).optional(),
            search: z.string().optional(),
            milestone: z.string().optional(),
            per_page: z.number().optional(),
        }),
    },
    async (args) => withToolDebug("list_issues", args, async () => handleListIssues(args)),
);

server.registerTool(
    "create_issue",
    {
        description: "Создать issue в проекте",
        inputSchema: z.object({
            project_id: projectIdSchema,
            title: z.string(),
            description: z.string().optional(),
            labels: labelsSchema,
            milestone_id: z.number().optional(),
            assignee_ids: z.array(z.number()).optional(),
        }),
    },
    async (args) => withToolDebug("create_issue", args, async () => handleCreateIssue(args)),
);

server.registerTool(
    "update_issue",
    {
        description: "Обновить issue: заголовок, описание, метки (labels/add_labels/remove_labels), закрыть/переоткрыть",
        inputSchema: z.object({
            project_id: projectIdSchema,
            issue_iid: z.union([z.number(), z.string()]),
            title: z.string().optional(),
            description: z.string().optional(),
            labels: labelsSchema,
            add_labels: labelsSchema,
            remove_labels: labelsSchema,
            state_event: z.enum(["close", "reopen"]).optional(),
        }),
    },
    async (args) => withToolDebug("update_issue", args, async () => handleUpdateIssue(args)),
);

server.registerTool(
    "get_pipeline_status",
    {
        description:
            "Статус последнего пайплайна по MR (mr_iid) или ветке (ref). При падении возвращает список упавших job'ов",
        inputSchema: z.object({
            project_id: projectIdSchema,
            mr_iid: z.number().optional(),
            ref: z.string().optional(),
        }),
    },
    async (args) => withToolDebug("get_pipeline_status", args, async () => handleGetPipelineStatus(args)),
);

// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

try {
    await main();
} catch (err) {
    logError(`Fatal error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
}
