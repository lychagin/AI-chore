#!/usr/bin/env node
/**
 * Extract failing assertions + response bodies from a newman JSON report.
 * Usage: node extract-failures.js <report.json>
 * Output: compact JSON to stdout — dedup'd failures with response bodies,
 * so a triage agent gets the exact root cause without reading a 10MB report.
 */
const fs = require("fs");

const file = process.argv[2];
if (!file) {
  console.error("usage: node extract-failures.js <report.json>");
  process.exit(1);
}

const j = JSON.parse(fs.readFileSync(file, "utf8"));
const run = j.run || {};
const stats = (run.stats && run.stats.assertions) || {};

function decodeStream(s) {
  if (!s) return null;
  try {
    if (s.type === "Buffer" && Array.isArray(s.data)) return Buffer.from(s.data).toString("utf8");
    if (Array.isArray(s)) return Buffer.from(s).toString("utf8");
    if (Array.isArray(s.data)) return Buffer.from(s.data).toString("utf8");
    if (typeof s === "string") return s;
    return JSON.stringify(s);
  } catch (e) {
    return null;
  }
}

const seen = new Map(); // key: step|code|firstErr -> aggregated failure
for (const ex of run.executions || []) {
  const errs = (ex.assertions || [])
    .filter((a) => a && a.error)
    .map((a) => a.error.message);
  if (!errs.length) continue;

  const step = (ex.item && ex.item.name) || "(unnamed)";
  const code = ex.response && ex.response.code;
  const key = step + "|" + code + "|" + errs[0];
  if (seen.has(key)) {
    seen.get(key).count++;
    continue;
  }
  let body = decodeStream(ex.response && ex.response.stream);
  if (body && body.length > 700) body = body.slice(0, 700) + "…";
  seen.set(key, {
    step,
    code,
    count: 1,
    assertErrors: [...new Set(errs)].slice(0, 4),
    responseBody: body,
  });
}

const out = {
  collection: file.split("/").pop(),
  assertions: { failed: stats.failed, total: stats.total },
  uniqueFailures: [...seen.values()],
};
process.stdout.write(JSON.stringify(out, null, 2));
