import assert from "node:assert";
import { test, summary } from "./_harness.mjs";
import { buildMrPayload, pickFallbackPath, publish } from "./publish.mjs";

await test("buildMrPayload create payload", () => {
    const p = buildMrPayload({
        title: "fix(x): [TASK-7] y",
        description: "DESC",
        sourceBranch: "task-7",
        targetBranch: "develop",
    });
    assert.strictEqual(p.source_branch, "task-7");
    assert.strictEqual(p.target_branch, "develop");
    assert.strictEqual(p.title, "fix(x): [TASK-7] y");
    assert.strictEqual(p.description, "DESC");
});

await test("pickFallbackPath sanitizes branch", () => {
    assert.strictEqual(
        pickFallbackPath("feat/mr-template"),
        ".swap/mr-description/feat-mr-template.md",
    );
});

await test("publish without --push only writes file", async () => {
    const writes = [];
    const res = await publish({
        description: "DESC",
        title: "t",
        sourceBranch: "task-7",
        targetBranch: "develop",
        push: false,
        cfg: {},
        deps: { writeFile: (p, c) => writes.push([p, c]), gitlab: null },
    });
    assert.strictEqual(res.published, false);
    assert.strictEqual(writes.length, 1);
    assert.ok(writes[0][0].endsWith("task-7.md"));
});

await test("publish with --push creates MR when none exists", async () => {
    const calls = [];
    const gitlab = {
        listOpenMrs: async () => [],
        createMr: async (payload) => {
            calls.push(["create", payload]);
            return { web_url: "https://gl/mr/1" };
        },
        updateMr: async () => {
            throw new Error("should not update");
        },
    };
    const res = await publish({
        description: "DESC",
        title: "t",
        sourceBranch: "task-7",
        targetBranch: "develop",
        push: true,
        cfg: { GITLAB_TOKEN: "g" },
        deps: { writeFile: () => {}, gitlab },
    });
    assert.strictEqual(res.published, true);
    assert.strictEqual(res.webUrl, "https://gl/mr/1");
    assert.strictEqual(calls[0][0], "create");
});

await test("publish with --push falls back to file on API error", async () => {
    const writes = [];
    const gitlab = {
        listOpenMrs: async () => {
            throw new Error("401");
        },
    };
    const res = await publish({
        description: "DESC",
        title: "t",
        sourceBranch: "task-7",
        targetBranch: "develop",
        push: true,
        cfg: { GITLAB_TOKEN: "g" },
        deps: { writeFile: (p, c) => writes.push([p, c]), gitlab },
    });
    assert.strictEqual(res.published, false);
    assert.ok(res.fallback);
    assert.strictEqual(writes.length, 1);
});

await test("publish with --push updates MR when one already exists", async () => {
    const calls = [];
    const gitlab = {
        listOpenMrs: async () => [{ iid: 42 }],
        createMr: async () => {
            throw new Error("should not create");
        },
        updateMr: async (iid, fields) => {
            calls.push(["update", iid, fields]);
            return { web_url: "https://gl/mr/42" };
        },
    };
    const res = await publish({
        description: "DESC",
        title: "t",
        sourceBranch: "task-7",
        targetBranch: "develop",
        push: true,
        cfg: { GITLAB_TOKEN: "g" },
        deps: { writeFile: () => {}, gitlab },
    });
    assert.strictEqual(res.published, true);
    assert.strictEqual(res.webUrl, "https://gl/mr/42");
    assert.strictEqual(calls[0][0], "update");
    assert.strictEqual(calls[0][1], 42);
    assert.strictEqual(calls[0][2].target_branch, "develop");
});

await test("publish with --push and no GITLAB_TOKEN falls back to file", async () => {
    const writes = [];
    const res = await publish({
        description: "DESC",
        title: "t",
        sourceBranch: "task-7",
        targetBranch: "develop",
        push: true,
        cfg: {},
        deps: { writeFile: (p, c) => writes.push([p, c]), gitlab: { listOpenMrs: async () => [] } },
    });
    assert.strictEqual(res.published, false);
    assert.ok(res.fallback);
    assert.strictEqual(writes.length, 1);
});

summary();
