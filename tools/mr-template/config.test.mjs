import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, summary } from "./_harness.mjs";
import { parseEnvrc, mergeConfig, findEnvrcPath } from "./config.mjs";

await test("parseEnvrc reads export lines, strips quotes and comments", () => {
    const txt = [
        "# comment",
        "export GITLAB_TOKEN=glpat-abc",
        'export GITLAB_URL="https://g/api/v4"',
        "OPENPROJECT_PROJECT='my-project'",
        "",
        "BROKEN LINE",
    ].join("\n");
    const out = parseEnvrc(txt);
    assert.strictEqual(out.GITLAB_TOKEN, "glpat-abc");
    assert.strictEqual(out.GITLAB_URL, "https://g/api/v4");
    assert.strictEqual(out.OPENPROJECT_PROJECT, "my-project");
    assert.ok(!("BROKEN LINE" in out));
});

await test("mergeConfig: real env overrides .envrc fallback", () => {
    const envrc = { GITLAB_TOKEN: "from-file", GITLAB_URL: "u" };
    const env = { GITLAB_TOKEN: "from-env" };
    const cfg = mergeConfig(envrc, env);
    assert.strictEqual(cfg.GITLAB_TOKEN, "from-env");
    assert.strictEqual(cfg.GITLAB_URL, "u");
});

await test("parseEnvrc: inline comment stripped from unquoted value", () => {
    const txt = "export A=val # comment\n";
    const out = parseEnvrc(txt);
    assert.strictEqual(out.A, "val");
});

await test("parseEnvrc: quoted value with trailing comment", () => {
    const txt = 'export B="x y" # comment\n';
    const out = parseEnvrc(txt);
    assert.strictEqual(out.B, "x y");
});

await test("findEnvrcPath: finds local .envrc", () => {
    const dir = mkdtempSync(join(tmpdir(), "envrc-test-"));
    try {
        const envrcFile = join(dir, ".envrc");
        writeFileSync(envrcFile, "export X=1\n");
        assert.strictEqual(findEnvrcPath(dir), envrcFile);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

await test("findEnvrcPath: returns null when not found and not a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "envrc-notfound-"));
    try {
        assert.strictEqual(findEnvrcPath(dir), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

summary();
