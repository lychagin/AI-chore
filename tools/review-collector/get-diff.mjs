import { execFileSync } from "node:child_process";

// ─── Pure functions (exported for testing) ────────────────────────────────────

/**
 * Normalises a raw git ref argument into a two-dot range that both
 * `git log` and `git diff` accept.
 *
 * Supported inputs:
 *   HEAD~3          → HEAD~3..HEAD   (last N commits)
 *   HEAD            → HEAD^..HEAD    (last commit)
 *   abc123          → abc123^..abc123 (single SHA)
 *   abc123..def456  → abc123..def456  (explicit range, pass-through)
 */
export function normalizeRef(raw) {
    if (!raw || raw.trim() === "") throw new Error("Empty git ref");
    const trimmed = raw.trim();

    const GIT_REF_REGEX = /^[A-Za-z0-9_./~^-]+(?:\.\.[A-Za-z0-9_./~^-]+)?$/;
    if (!GIT_REF_REGEX.test(trimmed)) {
        throw new Error(`Invalid git ref format: ${trimmed}`);
    }

    if (trimmed.includes("..")) return trimmed;
    if (/^HEAD~\d+$/.test(trimmed)) return `${trimmed}..HEAD`;
    return `${trimmed}^..${trimmed}`;
}

/**
 * Parses the raw stdout of `git log --format="%H\t%s\t%an"` into an array
 * of commit objects. SHA is truncated to 7 characters.
 */
export function parseCommits(rawLog) {
    return rawLog
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [sha, message, author] = line.split("\t");
            return { sha: sha.slice(0, 7), message, author };
        });
}

// ─── Git wrappers ─────────────────────────────────────────────────────────────

export function runGitLog(range, repoPath = process.cwd()) {
    return execFileSync("git", ["-C", repoPath, "log", range, "--format=%H\t%s\t%an"], { encoding: "utf8" });
}

export function runGitDiff(range, repoPath = process.cwd()) {
    return execFileSync("git", ["-C", repoPath, "diff", range], { encoding: "utf8" });
}

export function runGitFilesChanged(range, repoPath = process.cwd()) {
    return execFileSync("git", ["-C", repoPath, "diff", "--name-only", range], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);
}

/**
 * Returns the full diff payload for a git ref.
 * Throws (from execSync) if the ref is invalid or not in a git repo.
 */
export function buildOutput(rawRef, repoPath = process.cwd()) {
    const range = normalizeRef(rawRef);
    const commits = parseCommits(runGitLog(range, repoPath));
    const diff = runGitDiff(range, repoPath);
    const files_changed = runGitFilesChanged(range, repoPath);
    return { commits, diff, files_changed };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1] === new URL(import.meta.url).pathname) {
    // Usage: node get-diff.mjs [--repo <path>] <git-ref>
    const args = process.argv.slice(2);
    let repoPath = process.cwd();
    let rawRef = "HEAD";

    const repoIdx = args.indexOf("--repo");
    if (repoIdx !== -1) {
        repoPath = args[repoIdx + 1];
        args.splice(repoIdx, 2);
    }
    if (args.length > 0) rawRef = args[0];

    try {
        const output = buildOutput(rawRef, repoPath);
        process.stdout.write(JSON.stringify(output));
    } catch (e) {
        process.stderr.write(e.message + "\n");
        process.exit(1);
    }
}
