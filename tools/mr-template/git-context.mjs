"use strict";

import { spawnSync } from "node:child_process";

export function parseTaskId(branch) {
    const s = String(branch);
    const tagged = s.match(/task[-_/]?(\d{2,})/i);
    if (tagged) return tagged[1];
    const bare = s.match(/(?:^|[^\d])(\d{3,})(?:[^\d]|$)/);
    return bare ? bare[1] : null;
}

export function sanitizeBranch(branch) {
    return String(branch).replace(/[/\\]/g, "-");
}

export function detectChecklist(changedFiles) {
    const files = (changedFiles || []).map((f) => String(f).trim()).filter(Boolean);

    const openapi = files.some((f) => f.startsWith("openapi/"));
    const dgraph = files.some(
        (f) => f.startsWith("shared-components/dgraph-migrate/") || f.startsWith("shared-components/dgraph-seeder/"),
    );

    const services = [
        ...new Set(
            files
                .map((f) => {
                    const m = f.match(/^(backend|frontend)\/([^/]+)\//);
                    return m ? `${m[1]}/${m[2]}` : null;
                })
                .filter(Boolean),
        ),
    ].sort();

    const sides = [
        ...new Set(
            files
                .map((f) => {
                    if (f.startsWith("backend/")) return "backend";
                    if (f.startsWith("frontend/")) return "frontend";
                    return null;
                })
                .filter(Boolean),
        ),
    ].sort();

    const testFiles = files.filter((f) => /\.(spec|test)\.(ts|js|mjs)$/.test(f));

    return { openapi, dgraph, services, sides, testFiles };
}

/** @param {string[]} args argv без shell (защита от инъекции через имя ветки) */
function defaultRunner(args) {
    const result = spawnSync(args[0], args.slice(1), {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        throw new Error(detail || `Command failed (${result.status}): ${args.join(" ")}`);
    }
    return result.stdout;
}

const lines = (out) =>
    String(out)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

export function makeGit(run = defaultRunner) {
    return {
        currentBranch: () => run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        // Diff base для контекста MR: сравниваем с remote-версией целевой ветки,
        // а не с (потенциально устаревшей) локальной. Иначе в diff/commits попадают
        // чужие задачи, уже влитые в origin/<target>. fetch — best-effort (offline/
        // отсутствие remote не должно ронять генерацию). Если origin/<target> нет —
        // откатываемся на локальный <target>.
        resolveDiffBase: (target) => {
            try {
                run(["git", "fetch", "--quiet", "origin", target]);
            } catch {
                // offline / нет remote / нет такой ветки — используем локальный ref
            }
            try {
                const sha = run(["git", "rev-parse", "--verify", "--quiet", `origin/${target}`]).trim();
                if (sha) return `origin/${target}`;
            } catch {
                // origin/<target> отсутствует — fallback на локальную ветку
            }
            return target;
        },
        changedFiles: (target) => lines(run(["git", "diff", "--name-only", `${target}...HEAD`])),
        commits: (target) => lines(run(["git", "log", "--format=%h %s", `${target}..HEAD`])),
        diffstat: (target) => run(["git", "diff", "--stat", `${target}...HEAD`]).trim(),
        blameHints: (target) => lines(run(["git", "log", "-n", "5", "--format=%h %an %ad %s", target])).slice(0, 5),
    };
}
