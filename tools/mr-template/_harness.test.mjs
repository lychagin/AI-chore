import assert from "node:assert";
import { test, summary } from "./_harness.mjs";

await test("test() runs and assert passes", () => {
    assert.strictEqual(1 + 1, 2);
});

summary();
