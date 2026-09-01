#!/usr/bin/env python3
"""MR Monitor — автомониторинг и авто-rebase Merge Request в GitLab.

Мониторит один MR и доводит его до мержа в develop. Подробности: README.md.
"""
import argparse
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from enum import Enum


def _ssl_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def gitlab_request(method, base_url, path, token, params=None, body=None):
    """Выполнить запрос к GitLab API. Возвращает (status_code, parsed_json)."""
    url = base_url.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = None
    headers = {"PRIVATE-TOKEN": token}
    if body is not None:
        data = urllib.parse.urlencode(body).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, context=_ssl_ctx()) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"message": raw}
        return exc.code, parsed


def get_mr(base_url, token, project, iid, include_rebase=False):
    """GET одного MR. Бросает RuntimeError при не-200."""
    proj = urllib.parse.quote(project, safe="")
    params = {"include_rebase_in_progress": "true"} if include_rebase else None
    status, mr = gitlab_request(
        "GET", base_url, f"/projects/{proj}/merge_requests/{iid}", token, params=params
    )
    if status != 200:
        raise RuntimeError(f"GET MR !{iid} failed: HTTP {status}: {mr.get('message')}")
    return mr


class Action(Enum):
    WAIT = "wait"
    REBASE = "rebase"
    STOP_CONFLICT = "stop_conflict"
    STOP_BLOCKER = "stop_blocker"
    STOP_PIPELINE_FAILED = "stop_pipeline_failed"
    DONE_MERGED = "done_merged"
    STOP_CLOSED = "stop_closed"


_BLOCKER_STATUSES = {"discussions_not_resolved", "not_approved", "draft_status"}


def decide_action(mr):
    """Чистый диспетчер: по состоянию MR вернуть (Action, причина)."""
    state = mr.get("state")
    if state == "merged":
        return Action.DONE_MERGED, "MR смержен в develop"
    if state == "closed":
        return Action.STOP_CLOSED, "MR закрыт без мержа"
    pipeline = mr.get("head_pipeline") or {}
    if pipeline.get("status") == "failed":
        url = pipeline.get("web_url", "")
        return Action.STOP_PIPELINE_FAILED, f"пайплайн упал: {url}"
    dms = mr.get("detailed_merge_status")
    if dms == "conflict" or mr.get("has_conflicts"):
        return Action.STOP_CONFLICT, "конфликт слияния — нужно решать вручную"
    if dms in _BLOCKER_STATUSES:
        return Action.STOP_BLOCKER, f"MR заблокирован: {dms}"
    if dms == "need_rebase":
        return Action.REBASE, "требуется rebase"
    return Action.WAIT, f"статус: {dms}, пайплайн: {pipeline.get('status')}"


class RebaseResult(Enum):
    REBASED = "rebased"
    CONFLICT = "conflict"
    UNAVAILABLE = "unavailable"


def enable_auto_merge(base_url, token, project, iid, sha):
    """Включить merge-when-pipeline-succeeds. Возвращает (status, body)."""
    proj = urllib.parse.quote(project, safe="")
    body = {"merge_when_pipeline_succeeds": "true"}
    if sha:
        body["sha"] = sha
    return gitlab_request(
        "PUT", base_url, f"/projects/{proj}/merge_requests/{iid}/merge", token, body=body
    )


def rebase_via_api(base_url, token, project, iid, sleep=time.sleep, get_mr_fn=get_mr, max_polls=40):
    """Серверный rebase. REBASED / CONFLICT / UNAVAILABLE."""
    proj = urllib.parse.quote(project, safe="")
    status, _ = gitlab_request(
        "PUT", base_url, f"/projects/{proj}/merge_requests/{iid}/rebase", token
    )
    if status not in (200, 202):
        return RebaseResult.UNAVAILABLE
    for _ in range(max_polls):
        mr = get_mr_fn(base_url, token, project, iid, include_rebase=True)
        if not mr.get("rebase_in_progress"):
            if mr.get("merge_error"):
                return RebaseResult.CONFLICT
            return RebaseResult.REBASED
        sleep(15)
    return RebaseResult.UNAVAILABLE


def run_git(args, cwd, check=True):
    """Запустить git с захватом вывода."""
    return subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True, check=check
    )


def rebase_local(repo_dir, parent_dir, iid, source_branch, run=run_git):
    """Локальный rebase в отдельном worktree. (RebaseResult, worktree_path)."""
    worktree_path = os.path.join(parent_dir, f"MR-monitoring-{iid}")
    run(["fetch", "origin", source_branch, "develop"], repo_dir)
    run(["worktree", "add", "-B", source_branch, "--force",
         worktree_path, f"origin/{source_branch}"], repo_dir)
    rebase = run(["rebase", "origin/develop"], worktree_path, check=False)
    if rebase.returncode != 0:
        run(["rebase", "--abort"], worktree_path, check=False)
        return RebaseResult.CONFLICT, worktree_path
    push = run(["push", "--force-with-lease", "origin", source_branch],
               worktree_path, check=False)
    if push.returncode != 0:
        return RebaseResult.UNAVAILABLE, worktree_path
    return RebaseResult.REBASED, worktree_path


def cleanup_worktree(repo_dir, worktree_path, run=run_git):
    """Удалить worktree, если он создавался."""
    if worktree_path and os.path.isdir(worktree_path):
        run(["worktree", "remove", "--force", worktree_path], repo_dir, check=False)


def _ts():
    return datetime.now().strftime("%H:%M:%S")


def run(iid, project, base_url, token, repo_dir, interval,
        log=print, sleep=time.sleep):
    """Главный цикл мониторинга. Возвращает код выхода (0 merged / 1 error / 130 ctrl-c)."""
    parent_dir = os.path.dirname(os.path.abspath(repo_dir))
    worktree_path = None
    auto_merge_done = False
    stop_actions = {
        Action.STOP_CONFLICT, Action.STOP_BLOCKER,
        Action.STOP_PIPELINE_FAILED, Action.STOP_CLOSED,
    }
    try:
        while True:
            mr = get_mr(base_url, token, project, iid)
            action, reason = decide_action(mr)
            log(f"[{_ts()}] MR !{iid}: {reason}")
            if action == Action.DONE_MERGED:
                log(f"✅ MR !{iid} смержен в develop")
                return 0
            if action in stop_actions:
                log(f"❌ Остановка: {reason}")
                return 1
            if not auto_merge_done:
                st, _ = enable_auto_merge(base_url, token, project, iid, mr.get("sha"))
                if 200 <= st < 300:
                    log(f"[{_ts()}] auto-merge включён (HTTP {st})")
                    auto_merge_done = True
                else:
                    log(f"[{_ts()}] auto-merge не включён (HTTP {st}), повтор на следующей итерации")
            if action == Action.REBASE:
                res = rebase_via_api(base_url, token, project, iid)
                if res == RebaseResult.CONFLICT:
                    log("❌ Конфликт при rebase (API) — решайте вручную")
                    return 1
                if res == RebaseResult.UNAVAILABLE:
                    log(f"[{_ts()}] API rebase недоступен — локальный fallback")
                    res2, worktree_path = rebase_local(
                        repo_dir, parent_dir, iid, mr.get("source_branch")
                    )
                    if res2 == RebaseResult.CONFLICT:
                        log("❌ Конфликт при локальном rebase (выполнен abort)")
                        return 1
                    if res2 == RebaseResult.UNAVAILABLE:
                        log("❌ Не удалось выполнить push после локального rebase")
                        return 1
                    auto_merge_done = False  # force-push сбрасывает auto-merge
                    log(f"[{_ts()}] локальный rebase выполнен, перевключаю auto-merge")
                    continue
                log(f"[{_ts()}] rebase выполнен, продолжаю мониторинг")
            sleep(interval)
    except KeyboardInterrupt:
        log("\nПрервано пользователем")
        return 130
    finally:
        cleanup_worktree(repo_dir, worktree_path)


def _git_root():
    proc = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=False,
    )
    return proc.stdout.strip() or os.getcwd()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Мониторинг MR и авто-rebase до мержа в develop.",
    )
    parser.add_argument("mr_iid", type=int, help="IID merge request (например 2403)")
    parser.add_argument("--interval", type=int, default=300,
                        help="интервал опроса в секундах (по умолчанию 300)")
    parser.add_argument("--project", default=os.environ.get("DEFAULT_PROJECT_ID"),
                        help="path проекта (по умолчанию из DEFAULT_PROJECT_ID)")
    args = parser.parse_args(argv)

    base_url = os.environ.get("GITLAB_URL")
    token = os.environ.get("GITLAB_TOKEN")
    missing = [n for n, v in
               (("GITLAB_URL", base_url), ("GITLAB_TOKEN", token),
                ("--project/DEFAULT_PROJECT_ID", args.project)) if not v]
    if missing:
        print(f"❌ Не заданы: {', '.join(missing)}", file=sys.stderr)
        return 1

    return run(args.mr_iid, args.project, base_url, token,
               _git_root(), args.interval)


if __name__ == "__main__":
    sys.exit(main())
