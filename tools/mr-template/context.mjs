"use strict";

import { parseTaskId, detectChecklist } from "./git-context.mjs";
import { classifyType, taskUrl, parentUrl, fetchWorkPackage } from "./openproject.mjs";

export async function buildContext({
    cfg,
    git,
    target = "develop",
    taskIdOverride = null,
    fetchWorkPackageImpl = fetchWorkPackage,
}) {
    const sourceBranch = git.currentBranch();
    const taskId = taskIdOverride || parseTaskId(sourceBranch);
    // Сравниваем с remote-версией целевой ветки (origin/<target>), а не с локальной,
    // чтобы в контекст не попадали задачи, уже влитые в develop. Fallback на target
    // для git-моков без resolveDiffBase.
    const diffBase = git.resolveDiffBase ? git.resolveDiffBase(target) : target;
    const changed = git.changedFiles(diffBase);
    const checklist = detectChecklist(changed);

    const ctx = {
        sourceBranch,
        targetBranch: target,
        diffBase,
        taskId,
        needsTaskId: !taskId,
        taskUrl: taskId && cfg.OPENPROJECT_URL ? taskUrl(cfg.OPENPROJECT_URL, taskId) : null,
        type: null,
        openProjectError: null,
        parentUrl: null,
        subject: null,
        checklist,
        commits: git.commits(diffBase),
        diffstat: git.diffstat(diffBase),
        blameHints: git.blameHints(diffBase),
        testFilesInDiff: checklist.testFiles,
    };

    if (taskId && cfg.OPENPROJECT_URL && cfg.OPENPROJECTTOKEN) {
        try {
            const wp = await fetchWorkPackageImpl(taskId, {
                baseUrl: cfg.OPENPROJECT_URL,
                token: cfg.OPENPROJECTTOKEN,
            });
            ctx.type = classifyType(wp);
            ctx.subject = wp.subject || null;
            ctx.parentUrl = parentUrl(cfg.OPENPROJECT_URL, wp);
        } catch (err) {
            ctx.type = null; // OpenProject unavailable — command will ask for type
            ctx.openProjectError = String(err && err.message ? err.message : err);
        }
    }

    return ctx;
}
