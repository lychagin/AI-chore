"use strict";

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync } from "node:child_process";

const ENV_KEYS = [
    "GITLAB_TOKEN",
    "GITLAB_URL",
    "DEFAULT_PROJECT_ID",
    "OPENPROJECTTOKEN",
    "OPENPROJECT_URL",
    "OPENPROJECT_PROJECT",
];

function parseValue(raw) {
    const s = String(raw).trim();
    const q = s[0];
    if (q === '"' || q === "'") {
        const end = s.indexOf(q, 1);
        return end !== -1 ? s.slice(1, end) : s.slice(1);
    }
    return s.replace(/\s+#.*$/, "").trim();
}

export function parseEnvrc(content) {
    const out = {};
    for (const raw of String(content).split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
        if (!m) continue;
        const key = m[1];
        const value = parseValue(m[2]);
        out[key] = value;
    }
    return out;
}

export function findEnvrcPath(cwd = process.cwd()) {
    const local = resolve(cwd, ".envrc");
    if (existsSync(local)) return local;
    try {
        const commonDir = execSync("git rev-parse --git-common-dir", {
            cwd,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();
        const mainRoot = dirname(resolve(cwd, commonDir));
        const candidate = resolve(mainRoot, ".envrc");
        if (existsSync(candidate)) return candidate;
    } catch {
        // not a git repo or git unavailable — skip
    }
    return null;
}

export function mergeConfig(envrcVars, env = process.env) {
    const merged = {};
    for (const key of ENV_KEYS) {
        merged[key] = env[key] || envrcVars[key] || undefined;
    }
    return merged;
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
    const path = findEnvrcPath(cwd);
    const envrcVars = path ? parseEnvrc(readFileSync(path, "utf8")) : {};
    return mergeConfig(envrcVars, env);
}
