import assert from "node:assert";
import { test, summary } from "./_harness.mjs";
import { classifyType, taskUrl, parentUrl, fetchWorkPackage } from "./openproject.mjs";

const BASE = "https://op.example.ru";

await test("classifyType: Bug -> bug", () => {
    const wp = { _links: { type: { title: "Bug" } } };
    assert.strictEqual(classifyType(wp), "bug");
});

await test("classifyType: non-bug with parent -> feature-task", () => {
    const wp = {
        _links: { type: { title: "Task" }, parent: { href: "/api/v3/work_packages/100" } },
    };
    assert.strictEqual(classifyType(wp), "feature-task");
});

await test("classifyType: non-bug without parent -> task", () => {
    const wp = { _links: { type: { title: "Task" } } };
    assert.strictEqual(classifyType(wp), "task");
});

await test("taskUrl / parentUrl build human urls", () => {
    assert.strictEqual(taskUrl(BASE, "7137"), `${BASE}/work_packages/7137`);
    const wp = { _links: { parent: { href: "/api/v3/work_packages/100" } } };
    assert.strictEqual(parentUrl(BASE, wp), `${BASE}/work_packages/100`);
    assert.strictEqual(parentUrl(BASE, { _links: {} }), null);
});

await test("fetchWorkPackage uses Basic apikey auth and injected fetch", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fakeFetch = async (url, opts) => {
        seenUrl = url;
        seenAuth = opts.headers.Authorization;
        return { ok: true, json: async () => ({ subject: "S", _links: { type: { title: "Bug" } } }) };
    };
    const wp = await fetchWorkPackage("7137", {
        baseUrl: BASE,
        token: "tok",
        fetchImpl: fakeFetch,
    });
    assert.strictEqual(wp.subject, "S");
    assert.strictEqual(seenUrl, `${BASE}/api/v3/work_packages/7137`);
    assert.strictEqual(seenAuth, "Basic " + Buffer.from("apikey:tok").toString("base64"));
});

summary();
