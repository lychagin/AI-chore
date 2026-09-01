"use strict";

import { createGitlabClient } from "../review-collector/gitlab-client.mjs";

// api: async (endpoint, options) => json — compatible with createGitlabClient(...).gitlabApi
export function makeGitlabMrApi(api, projectId) {
    const base = `/projects/${encodeURIComponent(projectId)}/merge_requests`;
    return {
        listOpenMrs: (sourceBranch) => api(`${base}?source_branch=${encodeURIComponent(sourceBranch)}&state=opened`),
        createMr: (payload) => api(base, { method: "POST", body: JSON.stringify(payload) }),
        updateMr: (iid, payload) => api(`${base}/${iid}`, { method: "PUT", body: JSON.stringify(payload) }),
    };
}

// Factory for production use from the CLI.
// createGitlabClient(token, baseUrl) returns { gitlabApi, gitlabApiPaginated }.
export function createMrApiFromConfig(cfg) {
    const { gitlabApi } = createGitlabClient(cfg.GITLAB_TOKEN, cfg.GITLAB_URL);
    return makeGitlabMrApi(gitlabApi, cfg.DEFAULT_PROJECT_ID);
}
