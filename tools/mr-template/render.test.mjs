import assert from "node:assert";
import { test, summary } from "./_harness.mjs";
import { renderSkeleton, renderNativeTemplate } from "./render.mjs";

const baseCtx = {
    type: "task",
    taskId: "1042",
    taskUrl: "https://op/work_packages/1042",
    parentUrl: null,
    checklist: { openapi: false, dgraph: false, services: ["backend/x"], sides: ["backend"], testFiles: [] },
};

await test("renderSkeleton hides non-applicable conditional checks", () => {
    const md = renderSkeleton(baseCtx);
    assert.ok(md.includes("[TASK-1042](https://op/work_packages/1042)"));
    assert.ok(md.includes("backend/x"));
    assert.ok(!md.includes("OpenAPI изменён"));
    assert.ok(!md.includes("Скриншоты"));
});

await test("renderSkeleton shows openapi+frontend checks when applicable", () => {
    const md = renderSkeleton({
        ...baseCtx,
        checklist: { openapi: true, dgraph: false, services: ["frontend/app"], sides: ["frontend"], testFiles: [] },
    });
    assert.ok(md.includes("OpenAPI изменён"));
    assert.ok(md.includes("Скриншоты"));
    assert.ok(!md.includes("DGraph schema"));
});

await test("renderSkeleton bug type includes root cause + why-not-found", () => {
    const md = renderSkeleton({ ...baseCtx, type: "bug" });
    assert.ok(md.includes("Корневая причина"));
    assert.ok(md.includes("Почему не нашли"));
    assert.ok(md.includes("Регресс-тест"));
});

await test("renderSkeleton feature-task includes parent link", () => {
    const md = renderSkeleton({ ...baseCtx, type: "feature-task", parentUrl: "https://op/work_packages/50" });
    assert.ok(md.includes("https://op/work_packages/50"));
});

await test("renderNativeTemplate produces static skeleton with all conditional checks", () => {
    const md = renderNativeTemplate("task");
    assert.ok(md.includes("OpenAPI изменён"));
    assert.ok(md.includes("DGraph schema"));
    assert.ok(md.includes("Скриншоты"));
    assert.ok(md.includes("[TASK-XXXX](url)"));
});

await test("renderSkeleton renders bare TASK-id when taskUrl is null", () => {
    const md = renderSkeleton({ ...baseCtx, taskUrl: null });
    assert.ok(md.includes("TASK-1042"));
    assert.ok(!md.includes("(null)"));
});

summary();
