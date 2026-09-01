#!/usr/bin/env node
"use strict";

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.mjs";
import { makeGit } from "./git-context.mjs";
import { buildContext } from "./context.mjs";
import { renderSkeleton, renderNativeTemplate } from "./render.mjs";
import { publish } from "./publish.mjs";
import { createMrApiFromConfig } from "./gitlab.mjs";

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--push") args.push = true;
        else if (a === "--target") args.target = argv[++i];
        else if (a === "--task") args.task = argv[++i];
        else if (a === "--title") args.title = argv[++i];
        else if (a === "--file") args.file = argv[++i];
        else args._.push(a);
    }
    return args;
}

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const args = parseArgs(argv.slice(1));
    const cfg = loadConfig();
    const git = makeGit();
    const target = args.target || "develop";

    if (cmd === "context" || cmd === "skeleton") {
        const ctx = await buildContext({ cfg, git, target, taskIdOverride: args.task || null });
        if (ctx.taskId && ctx.openProjectError) {
            process.stderr.write(
                `warning: не удалось получить тип задачи из OpenProject (${ctx.openProjectError}). ` +
                    `Если это TLS/CA ошибка — задайте NODE_EXTRA_CA_CERTS на корпоративный CA-бандл.\n`,
            );
        }
        if (cmd === "context") {
            process.stdout.write(JSON.stringify(ctx, null, 2) + "\n");
            return;
        }
        if (ctx.needsTaskId && !ctx.type) {
            process.stderr.write("NEEDS_TASK_ID\n");
            process.exit(2);
        }
        if (!ctx.type) ctx.type = "task"; // type undetermined — neutral default
        process.stdout.write(renderSkeleton(ctx));
        return;
    }

    if (cmd === "gen-templates") {
        const dir = ".gitlab/merge_request_templates";
        mkdirSync(dir, { recursive: true });
        for (const type of ["task", "feature-task", "bug"]) {
            writeFileSync(resolve(dir, `${type}.md`), renderNativeTemplate(type), "utf8");
            process.stdout.write(`wrote ${dir}/${type}.md\n`);
        }
        return;
    }

    if (cmd === "publish") {
        if (!args.file) {
            process.stderr.write("error: publish requires --file <path> (markdown file with the MR description)\n");
            process.exit(1);
        }
        if (args.push && !args.title) {
            process.stderr.write("error: --push requires --title (the MR title)\n");
            process.exit(1);
        }
        let description;
        try {
            description = readFileSync(args.file, "utf8");
        } catch {
            process.stderr.write(`error: cannot read --file: ${args.file}\n`);
            process.exit(1);
        }
        const sourceBranch = git.currentBranch();
        const gitlab = args.push ? createMrApiFromConfig(cfg) : null;
        const res = await publish({
            description,
            title: args.title,
            sourceBranch,
            targetBranch: target,
            push: Boolean(args.push),
            cfg,
            deps: { gitlab },
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        return;
    }

    process.stderr.write(
        "usage: node tools/mr-template/index.mjs <context|skeleton|publish|gen-templates> [--push] [--target b] [--task N] [--title t] [--file f]\n",
    );
    process.exit(1);
}

main().catch((err) => {
    process.stderr.write(`error: ${err.message || err}\n`);
    process.exit(1);
});
