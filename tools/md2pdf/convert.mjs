#!/usr/bin/env node
/**
 * Markdown → PDF with rendered mermaid + GFM tables.
 *
 * Usage:
 *   node .scripts/md2pdf/convert.mjs <srcDir> [outDir]
 *   node .scripts/md2pdf/convert.mjs <srcDir> --out <outDir>
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = __dirname;
const DEFAULT_CSS = path.join(TOOL_DIR, "print.css");
const SKIP_DIRS = new Set(["pdf", "_build", "node_modules", ".git"]);

const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
];

function usage() {
  return `Markdown → PDF (GFM tables, mermaid → PNG).

Usage:
  node .scripts/md2pdf/convert.mjs <srcDir> [outDir]
  node .scripts/md2pdf/convert.mjs <srcDir> --out <outDir>

Options:
  -o, --out <dir>                 Output directory (default: <srcDir>/pdf)
      --css <file>                Print stylesheet (default: print.css next to this script)
  -p, --puppeteer-config <file>   Puppeteer JSON for mermaid-cli
      --keep-build                Keep intermediate markdown/html in <outDir>/_build
  -h, --help                      Show this help

Environment:
  CHROMIUM                    Chromium/Chrome for print-to-pdf (default: chromium)
  PUPPETEER_EXECUTABLE_PATH   Chrome binary for mermaid-cli (not the snap wrapper)
  PUPPETEER_CONFIG            Path to puppeteer JSON (same as --puppeteer-config)
  MD2PDF_CSS                  Path to print CSS (same as --css)
  MMDC                        mermaid-cli binary (default: mmdc)
  PANDOC                      pandoc binary (default: pandoc)
  MMDC_SCALE                  mermaid PNG scale (default: 2)
  MMDC_WIDTH                  mermaid PNG width (default: 2400)
`;
}

function parseArgs(argv) {
  const opts = {
    src: null,
    out: null,
    css: process.env.MD2PDF_CSS || DEFAULT_CSS,
    puppeteer: process.env.PUPPETEER_CONFIG || null,
    keepBuild: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (a === "-o" || a === "--out") {
      i += 1;
      opts.out = argv[i];
      continue;
    }
    if (a === "--css") {
      i += 1;
      opts.css = argv[i];
      continue;
    }
    if (a === "-p" || a === "--puppeteer-config") {
      i += 1;
      opts.puppeteer = argv[i];
      continue;
    }
    if (a === "--keep-build") {
      opts.keepBuild = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}\n\n${usage()}`);
    }
    positional.push(a);
  }
  opts.src = positional[0];
  if (positional[1]) {
    opts.out = positional[1];
  }
  if (!opts.src) {
    throw new Error(`srcDir is required\n\n${usage()}`);
  }
  return opts;
}

function run(cmd, args, spawnOpts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...spawnOpts,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim();
    const detail = err || `exit ${r.status}`;
    throw new Error(`${cmd} ${args.join(" ")}\n${detail}`);
  }
  return r;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function walkMd(dir, outDir, acc = []) {
  const outResolved = path.resolve(outDir);
  const names = fs.readdirSync(dir);
  names.forEach((name) => {
    if (SKIP_DIRS.has(name)) {
      return;
    }
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (path.resolve(full) === outResolved) {
        return;
      }
      walkMd(full, outDir, acc);
      return;
    }
    if (!name.endsWith(".md")) {
      return;
    }
    if (isInside(outResolved, full)) {
      return;
    }
    acc.push(full);
  });
  return acc;
}

function relNoExt(srcRoot, abs) {
  return path.relative(srcRoot, abs).replace(/\.md$/i, "");
}

function hasMermaid(mdPath) {
  return fs.readFileSync(mdPath, "utf8").includes("```mermaid");
}

function titleFromMd(mdPath) {
  const text = fs.readFileSync(mdPath, "utf8");
  const m = text.match(/^#\s+(\S.*)$/m);
  return m ? m[1].trim() : path.basename(mdPath, ".md");
}

function isChromeBinary(candidate) {
  if (!candidate) {
    return false;
  }
  try {
    if (!fs.existsSync(candidate)) {
      return false;
    }
    const real = fs.realpathSync(candidate);
    return path.basename(real) !== "snap";
  } catch {
    return false;
  }
}

function guessChromeBinary() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/snap/chromium/current/usr/lib/chromium-browser/chrome",
    "/usr/lib/chromium-browser/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  return candidates.find((p) => isChromeBinary(p)) || null;
}

function resolvePuppeteerConfig(explicitPath, buildDir) {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new Error(`Puppeteer config not found: ${explicitPath}`);
    }
    return path.resolve(explicitPath);
  }
  const local = path.join(TOOL_DIR, "puppeteer.json");
  if (fs.existsSync(local)) {
    return local;
  }
  const exe = guessChromeBinary();
  if (!exe) {
    return null;
  }
  ensureDir(buildDir);
  const generated = path.join(buildDir, "puppeteer.json");
  fs.writeFileSync(
    generated,
    `${JSON.stringify({ executablePath: exe, args: CHROME_ARGS }, null, 2)}\n`,
  );
  return generated;
}

function convertOne(srcMd, ctx) {
  const rel = relNoExt(ctx.srcRoot, srcMd);
  const buildMd = path.join(ctx.buildDir, `${rel}.md`);
  const html = path.join(ctx.buildDir, `${rel}.html`);
  const pdf = path.join(ctx.pdfDir, `${rel}.pdf`);
  ensureDir(path.dirname(buildMd));
  ensureDir(path.dirname(pdf));

  const buildCwd = path.dirname(buildMd);
  if (hasMermaid(srcMd)) {
    const mmdcArgs = [
      "-i",
      srcMd,
      "-o",
      path.basename(buildMd),
      "-e",
      "png",
      "-b",
      "white",
      "-s",
      ctx.mmdcScale,
      "-w",
      ctx.mmdcWidth,
    ];
    if (ctx.puppeteerConfig) {
      mmdcArgs.push("-p", ctx.puppeteerConfig);
    }
    run(ctx.mmdc, mmdcArgs, { cwd: buildCwd });
  } else {
    fs.copyFileSync(srcMd, buildMd);
  }

  const title = titleFromMd(srcMd);
  run(
    ctx.pandoc,
    [
      "-f",
      "gfm",
      "-t",
      "html5",
      "--standalone",
      "--embed-resources",
      `--resource-path=${buildCwd}`,
      `--css=${ctx.css}`,
      `--metadata=title:${title}`,
      "-o",
      html,
      path.basename(buildMd),
    ],
    { cwd: buildCwd },
  );

  run(ctx.chromium, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--print-to-pdf=${pdf}`,
    "--no-pdf-header-footer",
    `file://${html}`,
  ]);

  return { rel: `${rel}.pdf`, size: fs.statSync(pdf).size };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const srcRoot = path.resolve(opts.src);
  if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
    throw new Error(`srcDir is not a directory: ${srcRoot}`);
  }
  const pdfDir = path.resolve(opts.out || path.join(srcRoot, "pdf"));
  const css = path.resolve(opts.css);
  if (!fs.existsSync(css)) {
    throw new Error(`CSS not found: ${css}`);
  }

  const buildDir = path.join(pdfDir, "_build");
  ensureDir(pdfDir);
  ensureDir(buildDir);

  const puppeteerConfig = resolvePuppeteerConfig(
    opts.puppeteer,
    path.join(os.tmpdir(), "md2pdf"),
  );

  const ctx = {
    srcRoot,
    pdfDir,
    buildDir,
    css,
    puppeteerConfig,
    chromium: process.env.CHROMIUM || "chromium",
    mmdc: process.env.MMDC || "mmdc",
    pandoc: process.env.PANDOC || "pandoc",
    mmdcScale: process.env.MMDC_SCALE || "2",
    mmdcWidth: process.env.MMDC_WIDTH || "2400",
  };

  const files = walkMd(srcRoot, pdfDir).sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    console.error("No markdown files found");
    process.exit(1);
  }
  console.log(`Converting ${files.length} markdown files → ${pdfDir}`);
  if (puppeteerConfig) {
    console.log(`mermaid-cli puppeteer: ${puppeteerConfig}`);
  }
  const results = [];
  files.forEach((f) => {
    process.stdout.write(`  ${path.relative(srcRoot, f)} ... `);
    try {
      const r = convertOne(f, ctx);
      console.log(`ok (${Math.round(r.size / 1024)} KB)`);
      results.push(r);
    } catch (e) {
      console.log("FAIL");
      console.error(e.message);
      process.exit(1);
    }
  });
  if (!opts.keepBuild) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
  console.log(`\nDone: ${results.length} PDF in ${pdfDir}`);
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
