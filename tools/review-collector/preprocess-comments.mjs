import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";

export const SCHEMA_VERSION = "1.0";

/**
 * Given an array of flat JSONL records sharing the same discussion_id,
 * returns a single thread object for threads.jsonl.
 * Records must be sorted by reply_index_in_discussion ascending (as exported).
 */
export function reconstructThread(notes) {
    const root = notes.find((n) => n.is_root_note) ?? notes[0];
    const replies = notes.filter((n) => n !== root && !n.is_root_note).map((n) => n.note_body);

    const { code_snippets: rootSnippets, text: rootText } = splitCodeFences(root.note_body);
    const allSnippets = [...rootSnippets];
    const cleanReplies = replies.map((r) => {
        const { code_snippets, text } = splitCodeFences(r);
        allSnippets.push(...code_snippets);
        return normalizeText(text);
    });

    return {
        discussion_id: root.discussion_id,
        kind: root.discussion_kind,
        file_path: root.file_path ?? null,
        root_comment: normalizeText(rootText),
        replies: cleanReplies.filter(Boolean),
        code_snippets: allSnippets.filter(Boolean),
        resolved: root.discussion_resolved,
        mr_iid: root.mr_iid,
        source_file: root._source_file,
    };
}

/**
 * Strips markdown formatting from text (bold, italic, headers, links, inline code).
 * Does NOT strip code fences — use splitCodeFences for that first.
 */
export function normalizeText(text) {
    return text
        .replace(/```[\s\S]*?```/g, "") // remove any leftover code fences
        .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // inline code → plain
        .replace(/\*\*(.+?)\*\*/g, "$1") // bold
        .replace(/\*(.+?)\*/g, "$1") // italic
        .replace(/^#{1,6}\s+/gm, "") // headers
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
        .replace(/\n{3,}/g, "\n\n") // collapse blank lines
        .trim();
}

/**
 * Splits text into code fence blocks and the remaining text.
 * Returns { text: string, code_snippets: string[] }.
 */
export function splitCodeFences(text) {
    const code_snippets = [];
    const cleaned = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => {
        code_snippets.push(code.trim());
        return "";
    });
    return { text: cleaned.trim(), code_snippets };
}

/**
 * Filters notes_by_mr_author from the notes array before thread reconstruction.
 * Rule: keep note_by_mr_author=true only if:
 *   (a) it is the only note in the discussion (self-review), OR
 *   (b) it is a reply (is_root_note=false) — author responding to reviewer feedback
 * Remove if: note_by_mr_author=true AND is_root_note=true AND discussion has other notes.
 */
export function filterAuthorNotes(notes) {
    if (notes.length === 1) return notes; // single note — keep regardless
    return notes.filter((n) => {
        if (!n.note_by_mr_author) return true; // not by author — always keep
        if (!n.is_root_note) return true; // reply by author — keep (responding to reviewer)
        return false; // root note by author in multi-note thread — remove
    });
}

/**
 * Returns filenames (basename only) from processedDir that are NOT in alreadyProcessed.
 * Only considers *.jsonl files (not *.meta.json).
 */
export function detectNewFiles(processedDir, alreadyProcessed) {
    if (!existsSync(processedDir)) return [];
    const all = readdirSync(processedDir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".meta.json"));
    const processed = new Set(alreadyProcessed);
    return all.filter((f) => !processed.has(f));
}

// ─── State I/O ────────────────────────────────────────────────────────────────

export function loadState(patternsDir) {
    const statePath = join(patternsDir, "mining-state.json");
    if (!existsSync(statePath)) {
        return { schema_version: SCHEMA_VERSION, processed_files: [], raw_patterns: [], last_updated: null };
    }
    return JSON.parse(readFileSync(statePath, "utf8"));
}

export function saveState(patternsDir, state) {
    const statePath = join(patternsDir, "mining-state.json");
    const updated = { ...state, last_updated: new Date().toISOString() };
    writeFileSync(statePath, JSON.stringify(updated, null, 2));
}

// ─── JSONL processing ─────────────────────────────────────────────────────────

/**
 * Reads a JSONL file, returns array of flat note records
 * with _source_file injected (basename of the file).
 */
export function readJsonlFile(filePath) {
    const src = basename(filePath);
    return readFileSync(filePath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ ...JSON.parse(line), _source_file: src }));
}

/**
 * Groups flat records by discussion_id, applies filterAuthorNotes,
 * reconstructs each thread. Returns array of thread objects.
 */
export function buildThreads(records) {
    const byDiscussion = new Map();
    for (const r of records) {
        const key = r.discussion_id;
        if (!byDiscussion.has(key)) byDiscussion.set(key, []);
        byDiscussion.get(key).push(r);
    }
    const threads = [];
    for (const notes of byDiscussion.values()) {
        const sorted = notes.slice().sort((a, b) => a.reply_index_in_discussion - b.reply_index_in_discussion);
        const filtered = filterAuthorNotes(sorted);
        if (filtered.length > 0) threads.push(reconstructThread(filtered));
    }
    return threads;
}

/**
 * Writes threads array to patternsDir/threads.jsonl (one thread per line, overwrites).
 * Returns the output path.
 */
export function writeThreadsJsonl(patternsDir, threads) {
    const outPath = join(patternsDir, "threads.jsonl");
    writeFileSync(outPath, threads.map((t) => JSON.stringify(t)).join("\n") + "\n");
    return outPath;
}

/**
 * Moves a processed .jsonl file (and its .meta.json if present)
 * from pendingDir to processedDir.
 */
export function moveToProcessed(pendingDir, processedDir, filename) {
    renameSync(join(pendingDir, filename), join(processedDir, filename));
    const metaname = filename.replace(/\.jsonl$/, ".meta.json");
    const metaSrc = join(pendingDir, metaname);
    if (existsSync(metaSrc)) {
        renameSync(metaSrc, join(processedDir, metaname));
    }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

function main() {
    const projectDir = new URL(".", import.meta.url).pathname;
    const pendingDir = join(projectDir, "review", "raw", "pending");
    const processedDir = join(projectDir, "review", "raw", "processed");
    const patternsDir = join(projectDir, "patterns");

    mkdirSync(patternsDir, { recursive: true });
    mkdirSync(processedDir, { recursive: true });

    const state = loadState(patternsDir);
    const newFiles = detectNewFiles(pendingDir, state.processed_files);

    if (newFiles.length === 0) {
        console.log("No new files to process.");
        return;
    }

    const allThreads = [];
    for (const filename of newFiles) {
        const filePath = join(pendingDir, filename);
        const records = readJsonlFile(filePath);
        const threads = buildThreads(records);
        allThreads.push(...threads);
        state.processed_files.push(filename);
        moveToProcessed(pendingDir, processedDir, filename);
    }

    writeThreadsJsonl(patternsDir, allThreads);
    saveState(patternsDir, state);

    console.log(
        `Processed ${newFiles.length} new file(s), ${allThreads.length} threads written to patterns/threads.jsonl`,
    );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    try {
        main();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
