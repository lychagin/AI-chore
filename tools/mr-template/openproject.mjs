"use strict";

const stripSlash = (u) => String(u).replace(/\/+$/, "");

export function classifyType(workPackage, { bugTypeName = "Bug" } = {}) {
    const typeTitle = workPackage?._links?.type?.title;
    if (typeTitle === bugTypeName) return "bug";
    const hasParent = Boolean(workPackage?._links?.parent?.href);
    return hasParent ? "feature-task" : "task";
}

export function taskUrl(baseUrl, id) {
    return `${stripSlash(baseUrl)}/work_packages/${id}`;
}

export function parentUrl(baseUrl, workPackage) {
    const href = workPackage?._links?.parent?.href;
    if (!href) return null;
    const m = String(href).match(/work_packages\/(\d+)/);
    return m ? taskUrl(baseUrl, m[1]) : null;
}

export async function fetchWorkPackage(id, { baseUrl, token, fetchImpl = fetch }) {
    const url = `${stripSlash(baseUrl)}/api/v3/work_packages/${id}`;
    const auth = "Basic " + Buffer.from(`apikey:${token}`).toString("base64");
    const res = await fetchImpl(url, {
        headers: { Authorization: auth, Accept: "application/json" },
    });
    if (!res.ok) {
        throw new Error(`OpenProject API ${res.status} for work package ${id}`);
    }
    return res.json();
}
