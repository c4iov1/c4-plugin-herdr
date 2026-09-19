import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import providers  # noqa: E402
import usage  # noqa: E402


NOW = 1_800_000_000.0

ANTIGRAVITY_CLI = {
    "status": "SUCCESS",
    "command": {
        "name": "usage",
        "data": {
            "groups": [
                {
                    "name": "Gemini Models",
                    "buckets": [
                        {
                            "id": "gemini-weekly",
                            "name": "Weekly Limit Remaining",
                            "window": "weekly",
                            "remaining_fraction": 0.36,
                            "reset_time": "2027-01-21T08:00:00Z",
                        },
                        {
                            "id": "gemini-5h",
                            "name": "Five Hour Limit Remaining",
                            "window": "5h",
                            "remaining_fraction": 0.82,
                            "reset_time": "2027-01-15T12:00:00Z",
                        },
                    ],
                }
            ]
        },
    },
}

ANTIGRAVITY_LOCAL = {
    "response": {
        "groups": [
            {
                "displayName": "Gemini Models",
                "description": "Gemini Flash and Gemini Pro",
                "buckets": [
                    {
                        "bucketId": "gemini-5h",
                        "displayName": "Five Hour Limit Remaining",
                        "remaining": {"case": "remainingFraction", "value": 0.75},
                        "resetTime": "2027-01-15T12:00:00Z",
                    },
                    {
                        "bucketId": "disabled",
                        "displayName": "Disabled",
                        "remainingFraction": 0.1,
                        "disabled": True,
                    },
                ],
            }
        ]
    }
}


class ProviderParsing(unittest.TestCase):
    def test_antigravity_cli_windows(self):
        windows = providers.parse_antigravity(ANTIGRAVITY_CLI)
        self.assertEqual(
            [(window["kind"], window["used"], window["model"]) for window in windows],
            [("weekly", 64.0, "Gemini Models"), ("session", 18.0, "Gemini Models")],
        )
        self.assertEqual(windows[1]["label"], "Five Hour")

    def test_antigravity_local_nested_remaining(self):
        windows = providers.parse_antigravity(ANTIGRAVITY_LOCAL)
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["kind"], "session")
        self.assertEqual(windows[0]["used"], 25.0)

    def test_unknown_antigravity_window_stays_generic(self):
        payload = {
            "groups": [
                {
                    "displayName": "Gemini",
                    "buckets": [
                        {"bucketId": "rolling", "remainingFraction": 0.5},
                    ],
                }
            ]
        }
        window = providers.parse_antigravity(payload)[0]
        self.assertEqual(window["kind"], "quota")

    def test_empty_antigravity_payload_fails(self):
        with self.assertRaises(providers.ProviderError) as error:
            providers.parse_antigravity({"groups": []})
        self.assertEqual(error.exception.code, "format")

    def test_non_object_antigravity_payload_fails(self):
        with self.assertRaises(providers.ProviderError) as error:
            providers.parse_antigravity([])
        self.assertEqual(error.exception.code, "format")

    def test_fetch_antigravity_cli_uses_read_only_usage_command(self):
        result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=json.dumps(ANTIGRAVITY_CLI), stderr=""
        )
        with mock.patch.object(providers.subprocess, "run", return_value=result) as run:
            reading = providers.fetch_antigravity_cli("agy")
        command = run.call_args.args[0]
        self.assertEqual(command[:3], ["agy", "-p", "/usage"])
        self.assertEqual(reading["windows"][1]["kind"], "session")

    def test_gemini_falls_back_when_cli_login_fails(self):
        expected = {"plan": "Google AI Pro", "windows": []}
        with mock.patch.object(providers, "antigravity_binary", return_value="agy"), \
                mock.patch.object(
                    providers,
                    "fetch_antigravity_cli",
                    side_effect=providers.ProviderError("expired", client="Antigravity"),
                ), \
                mock.patch.object(providers, "fetch_antigravity_local", return_value=expected):
            self.assertEqual(providers.fetch_gemini(), expected)

    def test_process_detection_ignores_other_users(self):
        own_uid = os.getuid()
        output = (
            f"{own_uid} 100 /usr/local/bin/agy\n"
            f"{own_uid + 1} 200 /usr/local/bin/agy --csrf_token secret\n"
        )
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=output, stderr="")
        with mock.patch.object(providers.subprocess, "run", return_value=result):
            processes = providers.antigravity_processes()
        self.assertEqual([process["pid"] for process in processes], [100])

    def test_codex_five_hour_classification(self):
        payload = {
            "rate_limit": {
                "primary_window": {
                    "used_percent": 4,
                    "limit_window_seconds": 18000,
                    "reset_at": 1800002400,
                },
                "secondary_window": {
                    "used_percent": 10,
                    "limit_window_seconds": 604800,
                    "reset_at": 1800500000,
                },
            }
        }
        self.assertEqual(
            [window["kind"] for window in providers.parse_codex(payload)],
            ["session", "weekly"],
        )


class Rendering(unittest.TestCase):
    def setUp(self):
        self.display = usage.Display({})

    def reading(self, windows, fetched_at=NOW - 10):
        return {"windows": windows, "fetched_at": fetched_at}

    def test_status_prefers_five_hour_window(self):
        data = {
            "claude": self.reading(
                [
                    {"kind": "session", "used": 21, "resets_at": NOW + 3600},
                    {"kind": "weekly", "used": 90, "resets_at": NOW + 86400},
                ]
            ),
            "codex": {"error": {"code": "nologin"}},
            "gemini": {"error": {"code": "nologin"}},
        }
        self.assertEqual(
            usage.status_line(data, NOW, self.display),
            f"Claude 21%/5h->{datetime.fromtimestamp(NOW + 3600):%H:%M}",
        )

    def test_status_labels_weekly_fallback(self):
        data = {
            "claude": {"error": {"code": "nologin"}},
            "codex": {"error": {"code": "nologin"}},
            "gemini": self.reading(
                [{"kind": "weekly", "used": 64, "resets_at": NOW + 86400}]
            ),
        }
        line = usage.status_line(data, NOW, self.display)
        self.assertIn("Gemini 64%/7d->", line)

    def test_status_marks_stale_values(self):
        data = {
            "claude": self.reading(
                [{"kind": "session", "used": 21, "resets_at": NOW + 3600}],
                fetched_at=NOW - 3600,
            ),
            "codex": {"error": {"code": "nologin"}},
            "gemini": {"error": {"code": "nologin"}},
        }
        self.assertIn("~21%/5h", usage.status_line(data, NOW, self.display))

    def test_dashboard_fits_popup_width(self):
        data = usage.demo_data(NOW)
        for line in usage.dashboard_lines(data, NOW, False, False, 70, self.display):
            self.assertLessEqual(usage.text_width(line), 70, usage.ANSI.sub("", line))

    def test_dashboard_separates_antigravity_pools(self):
        lines = usage.dashboard_lines(
            usage.demo_data(NOW), NOW, False, False, 70, self.display
        )
        plain = "\n".join(usage.ANSI.sub("", line) for line in lines)
        self.assertIn("Gemini Models", plain)
        self.assertIn("Five Hour", plain)

    def test_provider_text_is_sanitized(self):
        self.assertEqual(usage.safe_text("Plan\x1b]0;spoof\x07\nName"), "Plan Name")


class CacheAndSetup(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name) / "state"
        self.config = Path(temporary.name) / "config"
        environment = {
            "HERDR_PLUGIN_STATE_DIR": str(self.state),
            "HERDR_PLUGIN_CONFIG_DIR": str(self.config),
        }
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_cache_round_trip(self):
        expected = {"claude": {"plan": "Pro", "windows": []}}
        usage.save_cache(expected)
        self.assertEqual(usage.load_cache(), expected)
        self.assertTrue(usage.cache_file().is_file())

    def test_generated_status_command_is_executable(self):
        path = usage.install_status_command()
        self.assertTrue(os.access(path, os.X_OK))
        self.assertEqual(
            subprocess.run(["/bin/sh", "-n", str(path)], check=False).returncode,
            0,
        )
        content = path.read_text(encoding="utf-8")
        self.assertIn("HERDR_PLUGIN_STATE_DIR", content)
        self.assertIn("usage.py", content)
        result = subprocess.run(
            [str(path)],
            capture_output=True,
            text=True,
            env={**os.environ, "USAGE_QUOTE_SUBS_DEMO": "1"},
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Claude 21%/5h", result.stdout)

    def test_config_snippet_uses_rebranded_action(self):
        snippet = usage.config_snippet(Path("/tmp/status.sh"))
        self.assertIn('command = "c4.usage-quote-subs.open"', snippet)
        self.assertIn('key = "prefix+u"', snippet)

    def test_config_snippet_quotes_status_path(self):
        snippet = usage.config_snippet(Path("/tmp/path with spaces/status.sh"))
        self.assertIn("'/tmp/path with spaces/status.sh'", snippet)

    def test_event_refreshes_only_after_turn(self):
        for status in ("done", "idle", "blocked"):
            with mock.patch.dict(
                os.environ,
                {"HERDR_PLUGIN_EVENT_JSON": json.dumps({"agent_status": status})},
            ), mock.patch.object(usage, "refresh") as refresh:
                usage.handle_event()
            refresh.assert_called_once_with(usage.EVENT_REFRESH_AGE)
        with mock.patch.dict(
            os.environ,
            {"HERDR_PLUGIN_EVENT_JSON": json.dumps({"agent_status": "working"})},
        ), mock.patch.object(usage, "refresh") as refresh:
            usage.handle_event()
        refresh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
