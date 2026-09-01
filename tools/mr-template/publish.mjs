"use strict";

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sanitizeBranch } from "./git-context.mjs";

const FALLBACK_DIR = ".swap/mr-description";

export function buildMrPayload({ title, description, sourceBranch, targetBranch }) {
    return {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        description,
    };
}

export function pickFallbackPath(branch) {
    return `${FALLBACK_DIR}/${sanitizeBranch(branch)}.md`;
}

function defaultWriteFile(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
}

export async function publish({
    description,
    title,
    sourceBranch,
    targetBranch = "develop",
    push = false,
    cfg = {},
    deps = {},
}) {
    const writeFile = deps.writeFile || defaultWriteFile;
    const fallbackPath = pickFallbackPath(sourceBranch);

    if (!push) {
        writeFile(fallbackPath, description);
        return { published: false, file: fallbackPath };
    }

    const gitlab = deps.gitlab;
    try {
        if (!cfg.GITLAB_TOKEN || !gitlab) {
            throw new Error("GITLAB_TOKEN отсутствует");
        }
        const payload = buildMrPayload({ title, description, sourceBranch, targetBranch });
        const existing = await gitlab.listOpenMrs(sourceBranch);
        let mr;
        if (existing.length > 0) {
            mr = await gitlab.updateMr(existing[0].iid, {
                title,
                description,
                target_branch: targetBranch,
            });
        } else {
            mr = await gitlab.createMr(payload);
        }
        return { published: true, webUrl: mr.web_url };
    } catch (err) {
        writeFile(fallbackPath, description);
        return { published: false, fallback: true, file: fallbackPath, error: String(err.message || err) };
    }
}
