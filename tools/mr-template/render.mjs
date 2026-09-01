"use strict";

import { TITLE_HINT, CONDITIONAL_CHECKS, PROSE, WHY_NOT_FOUND } from "./sections.mjs";

function checklistLines(checklist, { adaptive }) {
    const out = [];
    const services = checklist.services.length ? checklist.services.join(", ") : "—";
    const sides = checklist.sides.length ? checklist.sides.join(" / ") : "—";
    out.push(`- затронутые сервисы: ${adaptive ? services : "[список]"}`);
    out.push(`- backend / frontend: ${adaptive ? sides : "[backend / frontend]"}`);
    for (const check of CONDITIONAL_CHECKS) {
        const flagOn = check.flag === "frontend" ? checklist.sides.includes("frontend") : checklist[check.flag];
        if (adaptive && !flagOn) continue;
        out.push(`- [ ] ${check.text}`);
    }
    return out.join("\n");
}

function commonProse() {
    return ["## Что сделано", PROSE.whatDone, "", "## Как проверено", PROSE.howTested].join("\n");
}

function taskLink(ctx, adaptive) {
    if (!adaptive) return "[TASK-XXXX](url)";
    return ctx.taskUrl ? `[TASK-${ctx.taskId}](${ctx.taskUrl})` : `TASK-${ctx.taskId}`;
}

function emptyChecklist() {
    return { openapi: false, dgraph: false, services: [], sides: [], testFiles: [] };
}

function build(type, ctx, { adaptive }) {
    const parts = [TITLE_HINT, ""];

    if (type === "feature-task") {
        const parent = adaptive && ctx.parentUrl ? `[Родитель](${ctx.parentUrl})` : "[Feature #NN](url)";
        parts.push("## Родительская фича", parent, "");
    }

    parts.push("## Задача", taskLink(ctx, adaptive), "");

    if (type === "bug") {
        parts.push(
            "## Проблема",
            PROSE.problem,
            "",
            "## Корневая причина",
            PROSE.rootCause,
            "",
            "## Когда/кем привнесено",
            PROSE.introduced,
            "",
            "## Почему не нашли раньше",
            ...WHY_NOT_FOUND.map((w) => `- [ ] ${w}`),
            "",
            "## Исправление",
            PROSE.fix,
            "",
        );
    }

    parts.push(commonProse(), "");

    if (type === "bug") {
        parts.push("## Регресс-тест", "- [ ] добавлен  / - [ ] не нужен — обоснование:", "");
    }

    parts.push("## Чеклист", checklistLines(ctx.checklist || emptyChecklist(), { adaptive }));
    return parts.join("\n") + "\n";
}

export function renderSkeleton(ctx) {
    return build(ctx.type, ctx, { adaptive: true });
}

export function renderNativeTemplate(type) {
    return build(type, { taskId: "XXXX", checklist: emptyChecklist() }, { adaptive: false });
}
