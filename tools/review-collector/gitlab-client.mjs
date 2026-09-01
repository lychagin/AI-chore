import { readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadConfig() {
    const presetGitlabToken = process.env.GITLAB_TOKEN;
    loadEnv();
    if (presetGitlabToken) {
        process.env.GITLAB_TOKEN = presetGitlabToken;
    }
    loadGitlabTokenFromHomeFile();

    const GITLAB_URL = process.env.GITLAB_URL;
    const DEFAULT_PROJECT_ID = process.env.DEFAULT_PROJECT_ID;

    if (!GITLAB_URL) {
        throw new Error(
            "GITLAB_URL не задан в .env. Добавьте строку: GITLAB_URL=https://your-gitlab.example.com/api/v4",
        );
    }

    if (!DEFAULT_PROJECT_ID) {
        throw new Error(
            "DEFAULT_PROJECT_ID не задан в .env. Добавьте строку: DEFAULT_PROJECT_ID=your-group/your-project",
        );
    }

    return {
        GITLAB_TOKEN: process.env.GITLAB_TOKEN,
        GITLAB_URL,
        DEFAULT_PROJECT_ID,
    };
}

function loadEnv() {
    try {
        const envPath = resolve(__dirname, ".env");
        const envContent = readFileSync(envPath, "utf-8");
        envContent.split("\n").forEach((line) => {
            const [key, ...valueParts] = line.split("=");
            let value = valueParts.join("=").trim();
            if (key && !key.startsWith("#") && value) {
                value = value.replace(/^[\"']|[\"']$/g, "");
                process.env[key] = value;
            }
        });
    } catch (err) {
        // .env not found — normal for some environments
    }
}

function loadGitlabTokenFromHomeFile() {
    if (process.env.GITLAB_TOKEN) return;
    try {
        const tokenPath = join(homedir(), ".cursor", "gitlab-token");
        const raw = readFileSync(tokenPath, "utf-8").trim();
        if (raw) process.env.GITLAB_TOKEN = raw;
    } catch {
        // file absent — token from .env or CI
    }
}

export function createGitlabClient(token, baseUrl) {
    async function gitlabApi(endpoint, options = {}) {
        const url = `${baseUrl}${endpoint}`;
        const headers = {
            "PRIVATE-TOKEN": token,
            ...options.headers,
        };

        if (options.method && ["POST", "PUT", "PATCH"].includes(options.method)) {
            headers["Content-Type"] = "application/json";
        }

        const response = await fetch(url, { ...options, headers });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`GitLab API error (${response.status}): ${error}`);
        }

        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            const text = await response.text();
            return text ? JSON.parse(text) : null;
        }

        return response.json();
    }

    async function gitlabApiPaginated(endpoint, options = {}) {
        const allItems = [];
        let page = 1;
        const perPage = options.perPage || 100;

        while (true) {
            const separator = endpoint.includes("?") ? "&" : "?";
            const pageUrl = `${endpoint}${separator}per_page=${perPage}&page=${page}`;
            const data = await gitlabApi(pageUrl, { ...options, perPage: undefined });

            if (!Array.isArray(data)) {
                return data;
            }

            allItems.push(...data);
            if (data.length < perPage) break;
            page++;
        }

        return allItems;
    }

    return { gitlabApi, gitlabApiPaginated };
}

export async function fetchMrDiscussions(gitlabApiPaginated, projectId, mrIid) {
    const endpoint = `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions?per_page=100`;
    return gitlabApiPaginated(endpoint);
}

export async function fetchMrList(gitlabApiPaginated, projectId, options = {}) {
    let endpoint = `/projects/${encodeURIComponent(projectId)}/merge_requests?state=merged&order_by=updated_at&sort=desc`;

    if (options.since) endpoint += `&updated_after=${options.since}`;
    if (options.until) endpoint += `&updated_before=${options.until}`;
    if (options.author_id) endpoint += `&author_id=${options.author_id}`;

    return gitlabApiPaginated(endpoint);
}

export async function fetchMrInfo(gitlabApi, projectId, mrIid) {
    return gitlabApi(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`);
}

export function extractReviewComments(discussions) {
    const comments = [];

    for (const d of discussions) {
        const firstNote = d.notes?.[0];
        const isCreatedByReviewer = firstNote && !firstNote.system && !d.resolved;

        for (let i = 0; i < (d.notes || []).length; i++) {
            const n = d.notes[i];
            if (n.system) continue;

            const comment = {
                id: n.id,
                discussion_id: d.id,
                author: n.author?.username || n.author?.name || "Unknown",
                body: n.body,
                created_at: n.created_at,
                resolved: d.resolved || false,
                is_reply: i > 0,
            };

            if (n.position) {
                comment.type = "inline";
                comment.file = n.position.new_path;
                comment.line = n.position.new_line;
                comment.old_line = n.position.old_line;
                comment.old_path = n.position.old_path;
            } else {
                comment.type = "general";
            }

            comments.push(comment);
        }
    }

    return comments;
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
