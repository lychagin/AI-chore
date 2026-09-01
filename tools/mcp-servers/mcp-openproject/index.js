#!/usr/bin/env node

/**
 * MCP Server for OpenProject (API v3)
 *
 * Транспорт: stdio (JSON-RPC 2.0 через stdin/stdout).
 * Запуск: node index.js (регистрируется в .mcp.json как сервер "openproject").
 *
 * Зачем: чтение тикета, комментариев и скриншотов из Claude Code раньше шло через curl
 * в Bash. На обрыве связи curl отдаёт пустой ответ, и после таймаута неизвестно,
 * опубликовался комментарий или нет. Здесь сетевые ошибки классифицированы, а для
 * мутаций явно сказано, что состояние на сервере неизвестно.
 *
 * Источники переменных (приоритет по убыванию):
 *   1. окружение процесса (наследуется от Claude Code)
 *   2. .env рядом с index.js
 *   3. .envrc в корне репозитория (строки `export KEY=value`) — direnv до MCP не доходит
 *
 * Переменные окружения:
 *   OPENPROJECTTOKEN        — API-ключ OpenProject (обязательный)
 *   OPENPROJECT_URL         — база инстанса без /api/v3 (обязательный)
 *   OPENPROJECT_PROJECT     — проект по умолчанию для поиска (identifier, необязательный)
 *   OPENPROJECT_TIMEOUT_MS  — таймаут запроса, мс (default: 30000)
 *   NODE_EXTRA_CA_CERTS     — корпоративный CA; читается явно, поэтому работает,
 *                             даже если переменная появилась уже после старта Node
 *
 * Отладка:
 *   MCP_DEBUG               — логирование в stderr + файл (default: false)
 *   MCP_DEBUG_LOG_FILE      — путь к логу (default: /tmp/openproject-mcp.log)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { request as httpsRequest } from "node:https";
import { rootCertificates } from "node:tls";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Раскрывает $VAR и ${VAR} в значении. Отдельно обрабатывается $PWD: direnv
 * вычисляет его как каталог .envrc, а у MCP-процесса рабочий каталог другой —
 * без подстановки путь к CA (`$PWD/.scripts/…/openproject-ca.pem`) не находится.
 */
function expandEnvValue(value, baseDir) {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
        const name = braced || bare;
        if (name === "PWD" && baseDir) return baseDir;
        return process.env[name] ?? match;
    });
}

/** Значения из окружения родителя приоритетнее файлов — их не перетираем */
function applyEnvLines(lines, baseDir) {
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
        const value = expandEnvValue(unquoted, baseDir);
        if (value) process.env[key] = value;
    }
}

function loadEnvFile(path) {
    try {
        applyEnvLines(readFileSync(path, "utf-8").split("\n"), dirname(path));
    } catch (err) {
        if (err?.code !== "ENOENT") {
            console.error(`Warning: не удалось прочитать ${path}: ${err.message}`);
        }
    }
}

/**
 * Ищет .envrc вверх по дереву — сервер лежит в .scripts/mcp/mcp-servers/<name>.
 * Глубина 8, а не 4: из git worktree (.claude/worktrees/<name>/…) до корня
 * основного чекаута, где лежит незакоммиченный .envrc, идти на три уровня дальше.
 */
function loadRepoEnvrc() {
    let dir = __dirname;
    for (let depth = 0; depth < 8; depth += 1) {
        const candidate = join(dir, ".envrc");
        if (existsSync(candidate)) {
            loadEnvFile(candidate);
            return candidate;
        }
        const parent = resolve(dir, "..");
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

loadEnvFile(resolve(__dirname, ".env"));
const envrcPath = loadRepoEnvrc();

const OPENPROJECT_TOKEN = process.env.OPENPROJECTTOKEN;
const OPENPROJECT_URL = (process.env.OPENPROJECT_URL || "").replace(/\/+$/, "");
const OPENPROJECT_PROJECT = process.env.OPENPROJECT_PROJECT || "";
const TIMEOUT_MS = Number(process.env.OPENPROJECT_TIMEOUT_MS || 30000);
const CA_PATH = process.env.NODE_EXTRA_CA_CERTS || "";
const MCP_DEBUG = ["1", "true", "yes", "on"].includes(String(process.env.MCP_DEBUG || "").toLowerCase());
const MCP_DEBUG_LOG_FILE = process.env.MCP_DEBUG_LOG_FILE || "/tmp/openproject-mcp.log";

function logError(message) {
    console.error(message);
    if (!MCP_DEBUG) return;
    try {
        appendFileSync(MCP_DEBUG_LOG_FILE, `${message}\n`, "utf8");
    } catch {
        // логирование не должно ронять сервер
    }
}

function debugLog(event, payload = {}) {
    if (!MCP_DEBUG) return;
    logError(`[mcp-debug] ${new Date().toISOString()} ${event} ${JSON.stringify(payload)}`);
}

if (!OPENPROJECT_TOKEN) {
    logError("Error: OPENPROJECTTOKEN не задан (окружение, .env рядом с сервером или .envrc репозитория).");
    process.exit(1);
}
if (!OPENPROJECT_URL) {
    logError("Error: OPENPROJECT_URL не задан (например https://openproject.example.ru).");
    process.exit(1);
}

/**
 * CA читаем сами: Node разбирает NODE_EXTRA_CA_CERTS только при старте процесса,
 * а переменная может приехать из .envrc уже после запуска — тогда TLS падал бы
 * с UNABLE_TO_VERIFY_LEAF_SIGNATURE при формально заданном сертификате.
 */
let caCertificate;
if (CA_PATH) {
    try {
        // Явный ca ЗАМЕНЯЕТ системные корни, а не дополняет: без rootCertificates
        // цепочка не собирается и запрос падает на unable to get issuer certificate
        caCertificate = [...rootCertificates, readFileSync(CA_PATH, "utf8")];
    } catch (err) {
        logError(`Warning: не прочитан CA из NODE_EXTRA_CA_CERTS (${CA_PATH}): ${err.message}`);
    }
}

const AUTH_HEADER = `Basic ${Buffer.from(`apikey:${OPENPROJECT_TOKEN}`).toString("base64")}`;

logError(
    `openproject-mcp running (${OPENPROJECT_URL}, project: ${OPENPROJECT_PROJECT || "не задан"}, ` +
        `CA: ${caCertificate ? "загружен" : "системный"}${envrcPath ? `, .envrc: ${envrcPath}` : ""})`,
);

const MUTATING_METHODS = ["POST", "PATCH", "PUT", "DELETE"];

/**
 * Сетевые сбои превращаем в сообщение, из которого видно, применилась ли операция.
 * Иначе агент повторяет запрос вслепую и публикует комментарий дважды.
 */
function describeNetworkError(error, method, path) {
    const unknownState = MUTATING_METHODS.includes(method)
        ? " Состояние на сервере НЕИЗВЕСТНО: перечитай активность тикета перед повтором, иначе получится дубль."
        : "";
    const code = error?.code || error?.cause?.code;

    if (code === "ETIMEDOUT" || error?.message === "timeout") {
        return new Error(`OpenProject: таймаут ${TIMEOUT_MS}мс на ${method} ${path}.${unknownState}`);
    }
    if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH"].includes(code)) {
        return new Error(`OpenProject недоступен (${code}) на ${method} ${path} — вероятно выключен VPN.${unknownState}`);
    }
    const certCodes = [
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "CERT_HAS_EXPIRED",
    ];
    if (certCodes.includes(code)) {
        return new Error(
            `OpenProject: не проверяется сертификат (${code}) на ${method} ${path}. ` +
                "Проверь NODE_EXTRA_CA_CERTS — он должен указывать на корпоративный CA.",
        );
    }
    return new Error(`OpenProject: сбой запроса ${method} ${path}: ${error?.message || String(error)}.${unknownState}`);
}

/**
 * Запрос к API v3 через node:https — в отличие от fetch позволяет передать CA явно.
 * binary=true возвращает Buffer (скачивание вложений).
 */
function openProjectApi(path, { method = "GET", body, binary = false } = {}) {
    const url = new URL(path.startsWith("http") ? path : `${OPENPROJECT_URL}${path}`);
    const payload = body === undefined ? null : JSON.stringify(body);
    const startedAt = Date.now();

    return new Promise((resolvePromise, rejectPromise) => {
        const req = httpsRequest(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || 443,
                path: `${url.pathname}${url.search}`,
                method,
                ca: caCertificate,
                headers: {
                    Authorization: AUTH_HEADER,
                    Accept: binary ? "*/*" : "application/json",
                    ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const buffer = Buffer.concat(chunks);
                    debugLog("api_response", {
                        path: url.pathname,
                        method,
                        status: res.statusCode,
                        bytes: buffer.length,
                        elapsed_ms: Date.now() - startedAt,
                    });

                    // Вложения отдаются редиректом на файловое хранилище
                    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                        openProjectApi(res.headers.location, { method, binary }).then(resolvePromise, rejectPromise);
                        return;
                    }

                    if (res.statusCode >= 400) {
                        const text = buffer.toString("utf8");
                        let detail = text;
                        try {
                            const parsed = JSON.parse(text);
                            detail = parsed.message || parsed.description || text;
                        } catch {
                            // не JSON — отдаём как есть
                        }
                        const unknownState =
                            res.statusCode >= 500 && MUTATING_METHODS.includes(method)
                                ? " Состояние на сервере НЕИЗВЕСТНО: проверь результат перед повтором."
                                : "";
                        rejectPromise(
                            new Error(
                                `OpenProject API error (${res.statusCode}) на ${method} ${url.pathname}: ` +
                                    `${String(detail).slice(0, 500)}${unknownState}`,
                            ),
                        );
                        return;
                    }

                    if (binary) {
                        resolvePromise(buffer);
                        return;
                    }
                    const text = buffer.toString("utf8");
                    resolvePromise(text ? JSON.parse(text) : null);
                });
            },
        );

        req.setTimeout(TIMEOUT_MS, () => {
            req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
        });
        req.on("error", (error) => rejectPromise(describeNetworkError(error, method, url.pathname)));
        if (payload) req.write(payload);
        req.end();
    });
}

// --- Форматирование -----------------------------------------------------------

/** Длина текста, после которой он уезжает в файл, а не в ответ модели */
const TEXT_INLINE_LIMIT = 4000;

function textResult(text) {
    return { content: [{ type: "text", text }] };
}

function dumpToTempFile(prefix, payload) {
    try {
        const file = join(tmpdir(), `${prefix}${Date.now()}.json`);
        writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload, null, 2), "utf8");
        return file;
    } catch (err) {
        debugLog("temp_dump_failed", { prefix, error: err.message });
        return null;
    }
}

function linkTitle(wp, key) {
    return wp?._links?.[key]?.title || null;
}

/** id из href вида /api/v3/statuses/7 */
function idFromHref(href) {
    if (!href) return null;
    const parts = String(href).split("/");
    return parts[parts.length - 1];
}

function formatWorkPackageHeader(wp) {
    return [
        `#${wp.id} [${linkTitle(wp, "type") || "?"}] ${wp.subject}`,
        `Статус: ${linkTitle(wp, "status") || "?"}, приоритет: ${linkTitle(wp, "priority") || "?"}, ` +
            `готовность: ${wp.percentageDone ?? 0}%`,
        `Проект: ${linkTitle(wp, "project") || "?"}, автор: ${linkTitle(wp, "author") || "?"}, ` +
            `исполнитель: ${linkTitle(wp, "assignee") || "нет"}`,
        `Создан: ${wp.createdAt}, обновлён: ${wp.updatedAt}, lockVersion: ${wp.lockVersion}`,
        `${OPENPROJECT_URL}/work_packages/${wp.id}`,
    ].join("\n");
}

// --- Инструменты --------------------------------------------------------------

async function handleGetWorkPackage(args) {
    const { id } = args;
    const wp = await openProjectApi(`/api/v3/work_packages/${Number(id)}`);
    const description = wp.description?.raw || "";
    const lines = [formatWorkPackageHeader(wp), ""];

    if (description.length > TEXT_INLINE_LIMIT) {
        const dumpFile = dumpToTempFile(`mcp-openproject-wp-${wp.id}-description-`, description);
        lines.push(
            description.slice(0, TEXT_INLINE_LIMIT),
            "",
            `… описание обрезано (${description.length} символов).` +
                (dumpFile ? ` Полный текст: ${dumpFile}` : " Сохранить полный текст не удалось."),
        );
    } else {
        lines.push(description || "(описание пустое)");
    }

    return textResult(lines.join("\n"));
}

/** Кэш имён: в activities приходит только href пользователя, без title */
const userNameCache = new Map();

async function resolveUserName(href) {
    if (!href) return "?";
    if (userNameCache.has(href)) return userNameCache.get(href);
    let name = `user/${idFromHref(href)}`;
    try {
        const user = await openProjectApi(href);
        name = user?.name || name;
    } catch (err) {
        debugLog("user_resolve_failed", { href, error: err.message });
    }
    userNameCache.set(href, name);
    return name;
}

async function collectActivityEntries(elements) {
    const comments = [];
    const changes = [];
    for (const activity of elements) {
        const author = await resolveUserName(activity._links?.user?.href);
        const comment = activity.comment?.raw || "";
        if (comment.trim()) {
            comments.push({ id: activity.id, author, createdAt: activity.createdAt, comment });
        }
        const details = (activity.details || []).map((d) => d.raw).filter(Boolean);
        if (details.length > 0) {
            changes.push({ id: activity.id, author, createdAt: activity.createdAt, details });
        }
    }
    return { comments, changes };
}

async function handleGetActivities(args) {
    const { id, include_changes = false } = args;
    const response = await openProjectApi(`/api/v3/work_packages/${Number(id)}/activities`);
    const elements = response?._embedded?.elements || [];
    const { comments, changes } = await collectActivityEntries(elements);

    const dumpFile = dumpToTempFile(`mcp-openproject-wp-${Number(id)}-activities-`, elements);
    const lines = [
        `Активность #${Number(id)}: записей ${elements.length}, комментариев ${comments.length}, ` +
            `изменений ${changes.length}`,
        dumpFile ? `Полный JSON: ${dumpFile}` : "Полный JSON сохранить не удалось",
        "",
        "=== Комментарии ===",
    ];

    if (comments.length === 0) {
        lines.push("(нет)");
    } else {
        for (const c of comments) {
            lines.push(`[${c.createdAt}] @${c.author}:`, c.comment, "");
        }
    }

    if (include_changes) {
        lines.push("=== Изменения полей ===");
        if (changes.length === 0) {
            lines.push("(нет)");
        } else {
            for (const ch of changes) {
                lines.push(`[${ch.createdAt}] @${ch.author}: ${ch.details.join("; ")}`);
            }
        }
    }

    return textResult(lines.join("\n"));
}

/**
 * Имя вложения приходит с сервера и попадает в путь на диске: `../../.ssh/authorized_keys`
 * в fileName записал бы файл за пределами каталога. Оставляем только базовое имя и
 * безопасные символы.
 */
function sanitizeFileName(fileName, attachmentId) {
    // eslint-disable-next-line no-control-regex
    const base = basename(String(fileName || "")).replace(/[/\\:*?"<>|\x00-\x1f]/g, "_");
    const trimmed = base.replace(/^\.+/, "").trim();
    return trimmed || `attachment-${attachmentId}`;
}

async function handleGetAttachments(args) {
    const { id, download = false, target_dir } = args;
    const workPackageId = Number(id);
    const response = await openProjectApi(`/api/v3/work_packages/${workPackageId}/attachments`);
    const elements = response?._embedded?.elements || [];

    if (elements.length === 0) {
        return textResult(`У тикета #${workPackageId} вложений нет`);
    }

    const lines = [`Вложений у #${workPackageId}: ${elements.length}`, ""];
    let directory = null;
    if (download) {
        directory = resolve(target_dir || join(tmpdir(), `mcp-openproject-wp-${workPackageId}`));
        // 0700: во вложениях багов бывают скриншоты с чувствительными данными, а tmpdir общий
        mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    for (const attachment of elements) {
        const sizeKb = Math.round((attachment.fileSize || 0) / 1024);
        const base = `[${attachment.id}] ${attachment.fileName} (${attachment.contentType}, ${sizeKb} КБ)`;
        if (!download) {
            lines.push(base);
            continue;
        }
        try {
            const safeName = `${attachment.id}-${sanitizeFileName(attachment.fileName, attachment.id)}`;
            const filePath = resolve(directory, safeName);
            // страховка на случай, если санитизация пропустит экзотический случай
            if (filePath !== join(directory, safeName) || !filePath.startsWith(`${directory}${sep}`)) {
                throw new Error(`небезопасное имя файла: ${attachment.fileName}`);
            }
            const buffer = await openProjectApi(`/api/v3/attachments/${attachment.id}/content`, { binary: true });
            writeFileSync(filePath, buffer, { mode: 0o600 });
            lines.push(`${base}\n  → ${filePath}`);
        } catch (err) {
            lines.push(`${base}\n  → не скачано: ${err.message}`);
        }
    }

    if (download) {
        lines.push(
            "",
            `Каталог: ${directory} (права 0700). Изображения читаются инструментом Read.`,
            "Файлы не удаляются автоматически — чистить вручную, если в них чувствительные данные.",
        );
    }

    return textResult(lines.join("\n"));
}

async function handleAddComment(args) {
    const { id, comment } = args;
    const workPackageId = Number(id);
    const result = await openProjectApi(`/api/v3/work_packages/${workPackageId}/activities`, {
        method: "POST",
        body: { comment: { raw: comment } },
    });

    return textResult(
        [
            `Комментарий добавлен к #${workPackageId} (activity ${result?.id}).`,
            `${OPENPROJECT_URL}/work_packages/${workPackageId}/activity`,
        ].join("\n"),
    );
}

async function resolveStatusHref(statusName) {
    const response = await openProjectApi("/api/v3/statuses");
    const elements = response?._embedded?.elements || [];
    const wanted = String(statusName).trim().toLowerCase();
    const found = elements.find((s) => String(s.name).trim().toLowerCase() === wanted);
    if (!found) {
        const available = elements.map((s) => s.name).join(", ");
        throw new Error(`Статус "${statusName}" не найден. Доступные: ${available}`);
    }
    return { href: found._links.self.href, name: found.name };
}

async function handleUpdateWorkPackage(args) {
    const { id, subject, description, status, percentage_done, assignee_id, lock_version } = args;
    const workPackageId = Number(id);

    const payload = {};
    if (subject !== undefined) payload.subject = subject;
    if (description !== undefined) payload.description = { raw: description };
    if (percentage_done !== undefined) payload.percentageDone = percentage_done;

    const links = {};
    let statusName;
    if (status !== undefined) {
        const resolved = await resolveStatusHref(status);
        links.status = { href: resolved.href };
        statusName = resolved.name;
    }
    if (assignee_id !== undefined) {
        links.assignee = { href: `/api/v3/users/${Number(assignee_id)}` };
    }
    if (Object.keys(links).length > 0) payload._links = links;

    if (Object.keys(payload).length === 0) {
        throw new Error("update_work_package: не передано ни одного изменяемого поля");
    }

    // lockVersion обязателен: без него OpenProject отвечает 409 на конкурентную правку
    let lockVersion = lock_version;
    if (lockVersion === undefined) {
        const current = await openProjectApi(`/api/v3/work_packages/${workPackageId}`);
        lockVersion = current.lockVersion;
    }
    payload.lockVersion = lockVersion;

    const updated = await openProjectApi(`/api/v3/work_packages/${workPackageId}`, {
        method: "PATCH",
        body: payload,
    });

    const changed = Object.keys(payload).filter((k) => k !== "lockVersion" && k !== "_links");
    if (statusName) changed.push(`status=${statusName}`);
    if (assignee_id !== undefined) changed.push(`assignee=${assignee_id}`);

    return textResult([`Тикет #${workPackageId} обновлён (${changed.join(", ")}).`, formatWorkPackageHeader(updated)].join("\n"));
}

/** Часы OpenProject принимает в формате ISO 8601 duration */
function hoursToIso(hours) {
    const totalMinutes = Math.round(Number(hours) * 60);
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
        throw new Error(`log_time: некорректное количество часов: ${hours}`);
    }
    const wholeHours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `PT${wholeHours > 0 ? `${wholeHours}H` : ""}${minutes > 0 ? `${minutes}M` : ""}`;
}

async function resolveDefaultActivityHref(workPackageId) {
    const form = await openProjectApi("/api/v3/time_entries/form", {
        method: "POST",
        body: { _links: { workPackage: { href: `/api/v3/work_packages/${workPackageId}` } } },
    });
    const allowed = form?._embedded?.schema?.activity?._embedded?.allowedValues || [];
    if (allowed.length === 0) {
        throw new Error("log_time: OpenProject не вернул доступных видов деятельности — укажи activity_id явно");
    }
    return allowed[0]._links.self.href;
}

async function handleLogTime(args) {
    const { work_package_id, hours, comment, spent_on, activity_id } = args;
    const workPackageId = Number(work_package_id);
    const activityHref = activity_id
        ? `/api/v3/time_entries/activities/${Number(activity_id)}`
        : await resolveDefaultActivityHref(workPackageId);

    const body = {
        hours: hoursToIso(hours),
        spentOn: spent_on || new Date().toISOString().slice(0, 10),
        _links: {
            workPackage: { href: `/api/v3/work_packages/${workPackageId}` },
            activity: { href: activityHref },
        },
    };
    if (comment) body.comment = { raw: comment };

    const entry = await openProjectApi("/api/v3/time_entries", { method: "POST", body });

    return textResult(
        `Списано ${hours} ч на #${workPackageId} за ${body.spentOn} ` +
            `(time entry ${entry?.id}, вид: ${entry?._links?.activity?.title || idFromHref(activityHref)}).`,
    );
}

async function handleSearchWorkPackages(args) {
    const { project, subject, status, type, updated_after, per_page = 20 } = args;
    const filters = [];
    if (subject) filters.push({ subject: { operator: "~", values: [subject] } });
    if (status === "open") filters.push({ status: { operator: "o", values: [] } });
    else if (status === "closed") filters.push({ status: { operator: "c", values: [] } });
    else if (status) filters.push({ status: { operator: "=", values: [String(status)] } });
    if (type) filters.push({ type: { operator: "=", values: [String(type)] } });
    if (updated_after) filters.push({ updatedAt: { operator: "<>d", values: [updated_after, ""] } });

    const query = new URLSearchParams({
        pageSize: String(per_page),
        sortBy: '[["updatedAt","desc"]]',
    });
    if (filters.length > 0) query.set("filters", JSON.stringify(filters));

    const projectIdentifier = project ?? OPENPROJECT_PROJECT;
    const path = projectIdentifier
        ? `/api/v3/projects/${encodeURIComponent(projectIdentifier)}/work_packages?${query}`
        : `/api/v3/work_packages?${query}`;

    const response = await openProjectApi(path);
    const elements = response?._embedded?.elements || [];
    if (elements.length === 0) {
        return textResult("Тикетов по фильтру не найдено");
    }

    const lines = [`Найдено: ${elements.length} из ${response.total ?? "?"}`, ""];
    for (const wp of elements) {
        lines.push(
            `#${wp.id} [${linkTitle(wp, "status")}] ${wp.subject} ` +
                `(${linkTitle(wp, "type")}, обновлён ${String(wp.updatedAt).slice(0, 10)})`,
        );
    }
    return textResult(lines.join("\n"));
}

async function withToolDebug(name, args, handler) {
    const startedAt = Date.now();
    try {
        debugLog("tool_call_start", { tool: name, args });
        const result = await handler();
        debugLog("tool_call_success", { tool: name, elapsed_ms: Date.now() - startedAt });
        return result;
    } catch (error) {
        debugLog("tool_call_error", { tool: name, elapsed_ms: Date.now() - startedAt, error: error?.message });
        return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
        };
    }
}

const server = new McpServer({
    name: "openproject-mcp",
    version: "1.0.0",
});

const idSchema = z.union([z.number(), z.string()]);

server.registerTool(
    "get_work_package",
    {
        description:
            "Получить тикет OpenProject по ID: тип, статус, исполнитель, lockVersion и описание. " +
            "Заменяет curl к /api/v3/work_packages/<id>",
        inputSchema: z.object({ id: idSchema }),
    },
    async (args) => withToolDebug("get_work_package", args, async () => handleGetWorkPackage(args)),
);

server.registerTool(
    "get_work_package_activities",
    {
        description:
            "Комментарии тикета (и, при include_changes, изменения полей). Полный JSON сохраняется во временный файл",
        inputSchema: z.object({
            id: idSchema,
            include_changes: z.boolean().optional(),
        }),
    },
    async (args) => withToolDebug("get_work_package_activities", args, async () => handleGetActivities(args)),
);

server.registerTool(
    "get_work_package_attachments",
    {
        description:
            "Список вложений тикета; при download=true скачивает их (скриншоты багов) в каталог и возвращает пути " +
            "для чтения инструментом Read",
        inputSchema: z.object({
            id: idSchema,
            download: z.boolean().optional(),
            target_dir: z.string().optional(),
        }),
    },
    async (args) => withToolDebug("get_work_package_attachments", args, async () => handleGetAttachments(args)),
);

server.registerTool(
    "add_work_package_comment",
    {
        description: "Добавить комментарий к тикету OpenProject (markdown в теле)",
        inputSchema: z.object({
            id: idSchema,
            comment: z.string(),
        }),
    },
    async (args) => withToolDebug("add_work_package_comment", args, async () => handleAddComment(args)),
);

server.registerTool(
    "update_work_package",
    {
        description:
            "Изменить тикет: тема, описание, статус (по имени), процент готовности, исполнитель. " +
            "lockVersion подтягивается автоматически, если не передан",
        inputSchema: z.object({
            id: idSchema,
            subject: z.string().optional(),
            description: z.string().optional(),
            status: z.string().optional(),
            percentage_done: z.number().optional(),
            assignee_id: z.number().optional(),
            lock_version: z.number().optional(),
        }),
    },
    async (args) => withToolDebug("update_work_package", args, async () => handleUpdateWorkPackage(args)),
);

server.registerTool(
    "log_time",
    {
        description:
            "Списать время на тикет. spent_on в формате YYYY-MM-DD (по умолчанию сегодня); " +
            "вид деятельности берётся первым доступным, если не задан activity_id",
        inputSchema: z.object({
            work_package_id: idSchema,
            hours: z.number(),
            comment: z.string().optional(),
            spent_on: z.string().optional(),
            activity_id: z.number().optional(),
        }),
    },
    async (args) => withToolDebug("log_time", args, async () => handleLogTime(args)),
);

server.registerTool(
    "search_work_packages",
    {
        description:
            "Поиск тикетов: по подстроке темы, статусу (open/closed/имя), типу, дате обновления. " +
            "Проект по умолчанию берётся из OPENPROJECT_PROJECT",
        inputSchema: z.object({
            project: z.string().optional(),
            subject: z.string().optional(),
            status: z.string().optional(),
            type: z.string().optional(),
            updated_after: z.string().optional(),
            per_page: z.number().optional(),
        }),
    },
    async (args) => withToolDebug("search_work_packages", args, async () => handleSearchWorkPackages(args)),
);

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
