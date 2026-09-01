import assert from "node:assert";
import { test, summary } from "./_harness.mjs";
import { buildContext } from "./context.mjs";

const cfg = {
    OPENPROJECT_URL: "https://op",
    OPENPROJECTTOKEN: "t",
    GITLAB_TOKEN: "g",
    GITLAB_URL: "https://gl/api/v4",
    DEFAULT_PROJECT_ID: "grp/proj",
};

function fakeGit() {
    return {
        currentBranch: () => "task-7137-x",
        changedFiles: () => ["backend/x/a.ts", "openapi/p.yaml"],
        commits: () => ["abc fix"],
        diffstat: () => "1 file",
        blameHints: () => ["abc author date msg"],
    };
}

await test("buildContext assembles deterministic context", async () => {
    const fetchWp = async () => ({ subject: "Subj", _links: { type: { title: "Bug" } } });
    const ctx = await buildContext({
        cfg,
        git: fakeGit(),
        target: "develop",
        fetchWorkPackageImpl: fetchWp,
    });
    assert.strictEqual(ctx.taskId, "7137");
    assert.strictEqual(ctx.type, "bug");
    assert.strictEqual(ctx.taskUrl, "https://op/work_packages/7137");
    assert.strictEqual(ctx.subject, "Subj");
    assert.strictEqual(ctx.checklist.openapi, true);
    assert.strictEqual(ctx.targetBranch, "develop");
    assert.strictEqual(ctx.sourceBranch, "task-7137-x");
    assert.strictEqual(ctx.openProjectError, null);
});

await test("buildContext returns needsTaskId when branch has no number", async () => {
    const git = { ...fakeGit(), currentBranch: () => "feat/no-number" };
    const ctx = await buildContext({ cfg, git, target: "develop", fetchWorkPackageImpl: async () => ({}) });
    assert.strictEqual(ctx.taskId, null);
    assert.strictEqual(ctx.needsTaskId, true);
});

await test("buildContext degrades type to null when OpenProject unavailable", async () => {
    const fetchWp = async () => {
        throw new Error("network");
    };
    const ctx = await buildContext({ cfg, git: fakeGit(), target: "develop", fetchWorkPackageImpl: fetchWp });
    assert.strictEqual(ctx.type, null);
    assert.strictEqual(ctx.taskId, "7137");
    assert.ok(ctx.openProjectError);
});

summary();
