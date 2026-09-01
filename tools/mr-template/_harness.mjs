"use strict";

let passed = 0;
let failed = 0;

export async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed += 1;
        console.error(`  ✗ ${name}\n    ${err && err.message ? err.message : err}`);
    }
}

export function summary() {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}
