import io
import json
import unittest
from unittest import mock

import mr_monitor


class FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = body.encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestGitlabRequest(unittest.TestCase):
    @mock.patch("mr_monitor.urllib.request.urlopen")
    def test_get_returns_status_and_json(self, urlopen):
        urlopen.return_value = FakeResp(200, json.dumps({"iid": 2403}))
        status, data = mr_monitor.gitlab_request(
            "GET", "https://gl/api/v4", "/projects/1/merge_requests/2403", "tok"
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["iid"], 2403)

    @mock.patch("mr_monitor.urllib.request.urlopen")
    def test_http_error_returns_code_and_body(self, urlopen):
        import urllib.error
        urlopen.side_effect = urllib.error.HTTPError(
            "u", 403, "Forbidden", {}, io.BytesIO(json.dumps({"message": "no"}).encode())
        )
        status, data = mr_monitor.gitlab_request(
            "PUT", "https://gl/api/v4", "/x", "tok"
        )
        self.assertEqual(status, 403)
        self.assertEqual(data["message"], "no")


class TestDecideAction(unittest.TestCase):
    def _mr(self, **kw):
        base = {"state": "opened", "detailed_merge_status": "mergeable",
                "has_conflicts": False, "head_pipeline": {"status": "success"}}
        base.update(kw)
        return base

    def test_merged_is_done(self):
        a, _ = mr_monitor.decide_action(self._mr(state="merged"))
        self.assertEqual(a, mr_monitor.Action.DONE_MERGED)

    def test_closed_stops(self):
        a, _ = mr_monitor.decide_action(self._mr(state="closed"))
        self.assertEqual(a, mr_monitor.Action.STOP_CLOSED)

    def test_pipeline_failed_stops(self):
        a, _ = mr_monitor.decide_action(
            self._mr(head_pipeline={"status": "failed", "web_url": "u"})
        )
        self.assertEqual(a, mr_monitor.Action.STOP_PIPELINE_FAILED)

    def test_need_rebase(self):
        a, _ = mr_monitor.decide_action(self._mr(detailed_merge_status="need_rebase"))
        self.assertEqual(a, mr_monitor.Action.REBASE)

    def test_conflict_stops(self):
        a, _ = mr_monitor.decide_action(self._mr(detailed_merge_status="conflict"))
        self.assertEqual(a, mr_monitor.Action.STOP_CONFLICT)

    def test_blocker_stops(self):
        for s in ("discussions_not_resolved", "not_approved", "draft_status"):
            a, _ = mr_monitor.decide_action(self._mr(detailed_merge_status=s))
            self.assertEqual(a, mr_monitor.Action.STOP_BLOCKER, s)

    def test_ci_running_waits(self):
        a, _ = mr_monitor.decide_action(
            self._mr(detailed_merge_status="ci_still_running",
                     head_pipeline={"status": "running"})
        )
        self.assertEqual(a, mr_monitor.Action.WAIT)

    def test_canceled_pipeline_does_not_stop(self):
        a, _ = mr_monitor.decide_action(
            self._mr(detailed_merge_status="ci_still_running",
                     head_pipeline={"status": "canceled"})
        )
        self.assertEqual(a, mr_monitor.Action.WAIT)


class FakeProc:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class TestRebaseLocal(unittest.TestCase):
    def test_success_does_force_push(self):
        calls = []

        def fake_run(args, cwd, check=True):
            calls.append(args)
            return FakeProc(0)

        res, wt = mr_monitor.rebase_local("/repo", "/parent", 7, "feat/x", run=fake_run)
        self.assertEqual(res, mr_monitor.RebaseResult.REBASED)
        self.assertTrue(wt.endswith("MR-monitoring-7"))
        self.assertIn(["push", "--force-with-lease", "origin", "feat/x"], calls)

    def test_conflict_aborts(self):
        def fake_run(args, cwd, check=True):
            if args[0] == "rebase" and "--abort" not in args:
                return FakeProc(1, stderr="CONFLICT")
            return FakeProc(0)

        called = []
        def tracking_run(args, cwd, check=True):
            called.append(args)
            return fake_run(args, cwd, check)

        res, _ = mr_monitor.rebase_local("/repo", "/parent", 7, "feat/x", run=tracking_run)
        self.assertEqual(res, mr_monitor.RebaseResult.CONFLICT)
        self.assertIn(["rebase", "--abort"], called)

    def test_cleanup_removes_existing_worktree(self):
        called = []
        with mock.patch("mr_monitor.os.path.isdir", return_value=True):
            mr_monitor.cleanup_worktree(
                "/repo", "/parent/MR-monitoring-7",
                run=lambda args, cwd, check=True: called.append(args),
            )
        self.assertIn(["worktree", "remove", "--force", "/parent/MR-monitoring-7"], called)

    def test_cleanup_noop_when_no_path(self):
        called = []
        mr_monitor.cleanup_worktree(
            "/repo", None, run=lambda args, cwd, check=True: called.append(args)
        )
        self.assertEqual(called, [])

    def test_push_failure_returns_unavailable(self):
        def fake_run(args, cwd, check=True):
            if args[0] == "push":
                return FakeProc(1, stderr="protected branch")
            return FakeProc(0)

        res, wt = mr_monitor.rebase_local("/repo", "/parent", 7, "feat/x", run=fake_run)
        self.assertEqual(res, mr_monitor.RebaseResult.UNAVAILABLE)
        self.assertTrue(wt.endswith("MR-monitoring-7"))


class TestRebaseApi(unittest.TestCase):
    @mock.patch("mr_monitor.gitlab_request")
    def test_enable_auto_merge_calls_merge_endpoint(self, gr):
        gr.return_value = (200, {})
        status, _ = mr_monitor.enable_auto_merge("b", "t", "g/p", 7, "abc")
        self.assertEqual(status, 200)
        args, kwargs = gr.call_args
        self.assertEqual(args[0], "PUT")
        self.assertIn("/merge", args[2])
        self.assertEqual(kwargs["body"]["merge_when_pipeline_succeeds"], "true")

    @mock.patch("mr_monitor.gitlab_request")
    def test_api_rebase_unavailable_on_403(self, gr):
        gr.return_value = (403, {"message": "no"})
        res = mr_monitor.rebase_via_api("b", "t", "g/p", 7)
        self.assertEqual(res, mr_monitor.RebaseResult.UNAVAILABLE)

    @mock.patch("mr_monitor.gitlab_request")
    def test_api_rebase_success(self, gr):
        gr.return_value = (202, {"rebase_in_progress": True})
        seq = [
            {"rebase_in_progress": True, "merge_error": None},
            {"rebase_in_progress": False, "merge_error": None},
        ]
        res = mr_monitor.rebase_via_api(
            "b", "t", "g/p", 7, sleep=lambda s: None,
            get_mr_fn=lambda *a, **k: seq.pop(0),
        )
        self.assertEqual(res, mr_monitor.RebaseResult.REBASED)

    @mock.patch("mr_monitor.gitlab_request")
    def test_api_rebase_conflict(self, gr):
        gr.return_value = (202, {"rebase_in_progress": True})
        res = mr_monitor.rebase_via_api(
            "b", "t", "g/p", 7, sleep=lambda s: None,
            get_mr_fn=lambda *a, **k: {
                "rebase_in_progress": False,
                "merge_error": "Rebase failed. Please rebase locally",
            },
        )
        self.assertEqual(res, mr_monitor.RebaseResult.CONFLICT)


class TestRunLoop(unittest.TestCase):
    def test_returns_0_when_merged(self):
        mrs = [
            {"state": "opened", "detailed_merge_status": "mergeable",
             "head_pipeline": {"status": "running"}, "sha": "a"},
            {"state": "merged", "detailed_merge_status": "mergeable",
             "head_pipeline": {"status": "success"}, "sha": "a"},
        ]
        with mock.patch("mr_monitor.get_mr", side_effect=mrs), \
             mock.patch("mr_monitor.enable_auto_merge", return_value=(200, {})) as eam:
            rc = mr_monitor.run(7, "g/p", "b", "t", "/repo", 1,
                                log=lambda *a: None, sleep=lambda s: None)
        self.assertEqual(rc, 0)
        eam.assert_called_once()

    def test_returns_1_on_pipeline_failed(self):
        mr = {"state": "opened", "detailed_merge_status": "ci_must_pass",
              "head_pipeline": {"status": "failed", "web_url": "u"}, "sha": "a"}
        with mock.patch("mr_monitor.get_mr", return_value=mr):
            rc = mr_monitor.run(7, "g/p", "b", "t", "/repo", 1,
                                log=lambda *a: None, sleep=lambda s: None)
        self.assertEqual(rc, 1)

    def test_local_fallback_reenables_automerge(self):
        mrs = [
            {"state": "opened", "detailed_merge_status": "need_rebase",
             "head_pipeline": {"status": "success"}, "sha": "a", "source_branch": "feat/x"},
            {"state": "opened", "detailed_merge_status": "ci_still_running",
             "head_pipeline": {"status": "running"}, "sha": "b", "source_branch": "feat/x"},
            {"state": "merged", "detailed_merge_status": "mergeable",
             "head_pipeline": {"status": "success"}, "sha": "b", "source_branch": "feat/x"},
        ]
        with mock.patch("mr_monitor.get_mr", side_effect=mrs), \
             mock.patch("mr_monitor.enable_auto_merge", return_value=(200, {})) as eam, \
             mock.patch("mr_monitor.rebase_via_api",
                        return_value=mr_monitor.RebaseResult.UNAVAILABLE), \
             mock.patch("mr_monitor.rebase_local",
                        return_value=(mr_monitor.RebaseResult.REBASED, "/parent/MR-monitoring-7")), \
             mock.patch("mr_monitor.cleanup_worktree") as cw:
            rc = mr_monitor.run(7, "g/p", "b", "t", "/repo", 1,
                                log=lambda *a: None, sleep=lambda s: None)
        self.assertEqual(rc, 0)
        self.assertGreaterEqual(eam.call_count, 2)
        cw.assert_called_once()

    def test_main_parses_args(self):
        with mock.patch.dict("mr_monitor.os.environ",
                             {"GITLAB_URL": "b", "GITLAB_TOKEN": "t",
                              "DEFAULT_PROJECT_ID": "g/p"}, clear=False), \
             mock.patch("mr_monitor.subprocess.run",
                        return_value=FakeProc(0, stdout="/repo\n")), \
             mock.patch("mr_monitor.run", return_value=0) as run_fn:
            rc = mr_monitor.main(["2403", "--interval", "120"])
        self.assertEqual(rc, 0)
        self.assertEqual(run_fn.call_args.args[0], 2403)


if __name__ == "__main__":
    unittest.main()
