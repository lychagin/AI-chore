import assert from "node:assert";
import { test, summary } from "./_harness.mjs";
import { parseTaskId, sanitizeBranch, detectChecklist, makeGit } from "./git-context.mjs";

await test("parseTaskId extracts number from task-style branches", () => {
    assert.strictEqual(parseTaskId("task-7137-no-absense"), "7137");
    assert.strictEqual(parseTaskId("fix-task-7134-draft-tags"), "7134");
    assert.strictEqual(parseTaskId("feature/TASK-1042-mailbox"), "1042");
});

await test("parseTaskId returns null when no number", () => {
    assert.strictEqual(parseTaskId("feat/mr-template-tooling"), null);
});

await test("sanitizeBranch replaces slashes", () => {
    assert.strictEqual(sanitizeBranch("feat/mr-template"), "feat-mr-template");
    assert.strictEqual(sanitizeBranch("task-7137"), "task-7137");
});

await test("detectChecklist classifies changed files", () => {
    const files = [
        "openapi/paths/foo.yaml",
        "backend/time-booking/src/x.service.ts",
        "backend/time-booking/src/x.spec.ts",
        "frontend/web-app/src/a.component.ts",
        "shared-components/dgraph-migrate/2026.ts",
        "README.md",
    ];
    const r = detectChecklist(files);
    assert.strictEqual(r.openapi, true);
    assert.strictEqual(r.dgraph, true);
    assert.deepStrictEqual(r.services, ["backend/time-booking", "frontend/web-app"]);
    assert.deepStrictEqual(r.sides, ["backend", "frontend"]);
    assert.deepStrictEqual(r.testFiles, ["backend/time-booking/src/x.spec.ts"]);
});

await test("detectChecklist on docs-only diff is all-empty", () => {
    const r = detectChecklist(["docs/x.md"]);
    assert.strictEqual(r.openapi, false);
    assert.strictEqual(r.dgraph, false);
    assert.deepStrictEqual(r.services, []);
    assert.deepStrictEqual(r.sides, []);
    assert.deepStrictEqual(r.testFiles, []);
});

const argvLine = (args) => args.join(" ");

await test("makeGit builds commands and parses output via injected runner", () => {
    const calls = [];
    const run = (args) => {
        calls.push(args);
        const cmd = argvLine(args);
        if (cmd.includes("rev-parse --abbrev-ref")) return "feat/x\n";
        if (cmd.includes("diff --name-only")) return "a.ts\nb.ts\n\n";
        if (cmd.includes("log") && cmd.includes("--format=")) return "abc123 fix thing\n";
        return "";
    };
    const git = makeGit(run);
    assert.strictEqual(git.currentBranch(), "feat/x");
    assert.deepStrictEqual(git.changedFiles("develop"), ["a.ts", "b.ts"]);
    assert.deepStrictEqual(git.commits("develop"), ["abc123 fix thing"]);
    assert.ok(calls.some((a) => a.includes("develop...HEAD")));
});

await test("resolveDiffBase prefers origin/<target> when it exists", () => {
    const calls = [];
    const run = (args) => {
        calls.push(args);
        if (args.includes("--verify")) return "deadbeef\n";
        return "";
    };
    const git = makeGit(run);
    assert.strictEqual(git.resolveDiffBase("develop"), "origin/develop");
    assert.ok(calls.some((a) => a[0] === "git" && a[1] === "fetch" && a.includes("develop")));
    assert.ok(calls.some((a) => a.includes("--verify") && a.includes("origin/develop")));
});

await test("resolveDiffBase falls back to local target when origin ref missing", () => {
    const run = (args) => {
        if (args.includes("--verify")) throw new Error("no ref");
        return "";
    };
    const git = makeGit(run);
    assert.strictEqual(git.resolveDiffBase("develop"), "develop");
});

await test("resolveDiffBase uses cached origin/<target> when fetch fails (offline)", () => {
    const run = (args) => {
        if (args.includes("fetch")) throw new Error("offline");
        if (args.includes("--verify")) return "cachedsha\n";
        return "";
    };
    const git = makeGit(run);
    assert.strictEqual(git.resolveDiffBase("develop"), "origin/develop");
});

await test("resolveDiffBase falls back to local target when origin ref empty after failed fetch", () => {
    const run = (args) => {
        if (args.includes("fetch")) throw new Error("offline");
        if (args.includes("--verify")) return "";
        return "";
    };
    const git = makeGit(run);
    assert.strictEqual(git.resolveDiffBase("develop"), "develop");
});

await test("resolveDiffBase passes target as argv element (no shell interpolation)", () => {
    const calls = [];
    const nasty = "develop; rm -rf /";
    const run = (args) => {
        calls.push(args);
        if (args.includes("--verify")) return "deadbeef\n";
        return "";
    };
    const git = makeGit(run);
    assert.strictEqual(git.resolveDiffBase(nasty), `origin/${nasty}`);
    const fetchCall = calls.find((a) => a[1] === "fetch");
    assert.deepStrictEqual(fetchCall, ["git", "fetch", "--quiet", "origin", nasty]);
    const verifyCall = calls.find((a) => a.includes("--verify"));
    assert.ok(verifyCall.includes(`origin/${nasty}`));
});

summary();
