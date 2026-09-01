import assert from "node:assert";
import { test, summary } from "./_harness.mjs";
import { makeGitlabMrApi } from "./gitlab.mjs";

await test("makeGitlabMrApi builds encoded endpoints and methods", async () => {
    const calls = [];
    const api = async (endpoint, options = {}) => {
        calls.push([endpoint, options.method || "GET", options.body]);
        if (endpoint.includes("merge_requests?")) return [];
        return { web_url: "u" };
    };
    const gl = makeGitlabMrApi(api, "grp/proj");

    await gl.listOpenMrs("task-7");
    await gl.createMr({ title: "t", description: "d", source_branch: "task-7", target_branch: "develop" });

    const enc = encodeURIComponent("grp/proj");
    assert.ok(calls[0][0].startsWith(`/projects/${enc}/merge_requests?`));
    assert.ok(calls[0][0].includes("source_branch=task-7"));
    assert.ok(calls[0][0].includes("state=opened"));
    assert.strictEqual(calls[1][1], "POST");
    assert.ok(calls[1][0] === `/projects/${enc}/merge_requests`);
});

summary();
