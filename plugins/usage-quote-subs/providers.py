"""Subscription usage providers for Claude Code, Codex, and Antigravity."""

import hashlib
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path


class ProviderError(Exception):
    def __init__(self, code, retry_after=0, **params):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after
        self.params = params


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


PUBLIC_HTTP = urllib.request.build_opener(NoRedirect)


def to_epoch(value):
    if isinstance(value, (int, float)):
        return value / 1000 if value > 1e11 else value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def request_json(url, headers, client_name):
    request = urllib.request.Request(url, headers=headers)
    try:
        with PUBLIC_HTTP.open(request, timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise ProviderError("expired", client=client_name)
        if error.code == 429:
            retry = error.headers.get("Retry-After", "")
            raise ProviderError("limited", max(300, int(retry) if retry.isdigit() else 0))
        raise ProviderError("http", status=error.code)
    except ValueError:
        raise ProviderError("format")
    except OSError:
        raise ProviderError("network")


def claude_credentials(config_dir):
    credential_file = Path(config_dir) / ".credentials.json"
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        try:
            yield credential_file.read_text(encoding="utf-8")
        except OSError:
            pass
    if sys.platform == "darwin":
        digest = hashlib.sha256(config_dir.encode()).hexdigest()[:8]
        for service in (f"Claude Code-credentials-{digest}", "Claude Code-credentials"):
            try:
                result = subprocess.run(
                    ["/usr/bin/security", "find-generic-password", "-s", service, "-w"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
            except (OSError, subprocess.SubprocessError):
                continue
            if result.returncode == 0:
                yield result.stdout
    if not os.environ.get("CLAUDE_CONFIG_DIR"):
        try:
            yield credential_file.read_text(encoding="utf-8")
        except OSError:
            return


def claude_oauth():
    environment_token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if environment_token:
        return {"accessToken": environment_token}
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")
    for raw in claude_credentials(config_dir):
        try:
            oauth = json.loads(raw).get("claudeAiOauth") or {}
        except (ValueError, AttributeError):
            continue
        if oauth.get("accessToken"):
            return oauth
    raise ProviderError("nologin")


def parse_claude(payload):
    windows = []
    for key, kind in (("five_hour", "session"), ("seven_day", "weekly")):
        window = payload.get(key)
        if isinstance(window, dict) and isinstance(window.get("utilization"), (int, float)):
            windows.append({
                "kind": kind,
                "used": window["utilization"],
                "resets_at": to_epoch(window.get("resets_at")),
            })
    for limit in payload.get("limits") or []:
        model = ((limit.get("scope") or {}).get("model") or {}).get("display_name")
        if limit.get("kind") == "weekly_scoped" and model and isinstance(limit.get("percent"), (int, float)):
            windows.append({
                "kind": "weekly",
                "model": model,
                "used": limit["percent"],
                "resets_at": to_epoch(limit.get("resets_at")),
            })
    if not windows:
        raise ProviderError("format")
    return windows


def fetch_claude():
    oauth = claude_oauth()
    expires_at = oauth.get("expiresAt")
    if isinstance(expires_at, (int, float)) and expires_at / 1000 < __import__("time").time():
        raise ProviderError("expired", client="Claude Code")
    payload = request_json(
        "https://api.anthropic.com/api/oauth/usage",
        {
            "Authorization": f"Bearer {oauth['accessToken']}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "usage-quote-subs/0.1.0",
        },
        "Claude Code",
    )
    tier = oauth.get("rateLimitTier") or ""
    match = re.search(r"max_(\d+x)", tier)
    plan = f"Max {match.group(1)}" if match else (oauth.get("subscriptionType") or "").title()
    return {"plan": plan, "windows": parse_claude(payload)}


def classify_window(seconds, fallback):
    hours = (seconds or 0) / 3600
    if not hours:
        return {"kind": fallback}
    if round(hours) == 5:
        return {"kind": "session"}
    if 6 <= hours / 24 <= 8:
        return {"kind": "weekly"}
    if hours < 48:
        return {"kind": "hours", "n": round(hours)}
    return {"kind": "days", "n": round(hours / 24)}


def parse_codex(payload):
    windows = []
    limits = payload.get("rate_limit") or {}
    for key, fallback in (("primary_window", "session"), ("secondary_window", "weekly")):
        window = limits.get(key)
        if isinstance(window, dict) and isinstance(window.get("used_percent"), (int, float)):
            windows.append({
                **classify_window(window.get("limit_window_seconds"), fallback),
                "used": window["used_percent"],
                "resets_at": to_epoch(window.get("reset_at")),
            })
    if not windows:
        raise ProviderError("format")
    return windows


def fetch_codex():
    auth_file = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "auth.json"
    try:
        auth = json.loads(auth_file.read_text(encoding="utf-8"))
    except (OSError, ValueError, KeyError, TypeError):
        auth = None
    if auth is None and sys.platform == "darwin":
        try:
            result = subprocess.run(
                ["/usr/bin/security", "find-generic-password", "-s", "Codex Auth", "-w"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            auth = json.loads(result.stdout) if result.returncode == 0 else None
        except (OSError, ValueError, subprocess.SubprocessError):
            auth = None
    try:
        tokens = auth["tokens"]
        headers = {
            "Authorization": f"Bearer {tokens['access_token']}",
            "User-Agent": "codex-cli",
        }
    except (KeyError, TypeError):
        raise ProviderError("nologin")
    if tokens.get("account_id"):
        headers["ChatGPT-Account-Id"] = tokens["account_id"]
    payload = request_json(
        "https://chatgpt.com/backend-api/wham/usage", headers, "Codex"
    )
    return {
        "plan": f"ChatGPT {(payload.get('plan_type') or '').title()}".strip(),
        "windows": parse_codex(payload),
    }


def antigravity_binary():
    configured = os.environ.get("ANTIGRAVITY_AGY_PATH")
    if configured and Path(configured).is_file():
        return configured
    found = shutil.which("agy") or shutil.which("antigravity-cli")
    if found:
        return found
    candidate = Path.home() / ".local" / "bin" / "agy"
    return str(candidate) if candidate.is_file() else None


def quota_kind(bucket):
    explicit = str(bucket.get("window") or "").lower()
    text = " ".join(
        str(bucket.get(key) or "")
        for key in ("id", "bucketId", "name", "displayName", "description")
    ).lower()
    if explicit in ("5h", "session") or re.search(r"(?:^|\W)(?:5\s*h|five[ -]hour)(?:\W|$)", text):
        return "session"
    if explicit in ("weekly", "7d") or "weekly" in text or re.search(r"(?:^|\W)7\s*d(?:\W|$)", text):
        return "weekly"
    return "quota"


def parse_antigravity(payload):
    if not isinstance(payload, dict):
        raise ProviderError("format")
    command_data = ((payload.get("command") or {}).get("data") or {}) if isinstance(payload, dict) else {}
    body = command_data or payload.get("response") or payload.get("summary") or payload
    groups = body.get("groups") if isinstance(body, dict) else None
    if not isinstance(groups, list):
        raise ProviderError("format")
    windows = []
    for group in groups:
        group_name = group.get("name") or group.get("displayName") or "Gemini"
        for bucket in group.get("buckets") or []:
            if bucket.get("disabled") is True:
                continue
            remaining = bucket.get("remaining_fraction")
            if remaining is None:
                remaining = bucket.get("remainingFraction")
            nested = bucket.get("remaining") or {}
            if remaining is None and isinstance(nested, dict):
                remaining = nested.get("remainingFraction")
                if remaining is None and nested.get("case") == "remainingFraction":
                    remaining = nested.get("value")
            if not isinstance(remaining, (int, float)):
                continue
            bucket_name = bucket.get("name") or bucket.get("displayName") or bucket.get("id") or bucket.get("bucketId") or "Quota"
            windows.append({
                "kind": quota_kind(bucket),
                "label": str(bucket_name).replace(" Limit Remaining", ""),
                "model": group_name,
                "used": round((1 - max(0.0, min(1.0, remaining))) * 100, 2),
                "resets_at": to_epoch(bucket.get("reset_time") or bucket.get("resetTime")),
            })
    if not windows:
        raise ProviderError("format")
    return windows


def fetch_antigravity_cli(binary):
    try:
        result = subprocess.run(
            [binary, "-p", "/usage", "--output-format", "json", "--print-timeout", "15s"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ProviderError("network")
    if result.returncode != 0:
        raise ProviderError("expired", client="Antigravity")
    try:
        payload = json.loads(result.stdout)
    except ValueError:
        raise ProviderError("format")
    if payload.get("status") not in (None, "SUCCESS"):
        raise ProviderError("expired", client="Antigravity")
    return {
        "plan": payload.get("plan_tier") or "Google AI",
        "windows": parse_antigravity(payload),
    }


def extract_flag(command, flag):
    match = re.search(rf"{re.escape(flag)}(?:=|\s+)([^\s]+)", command)
    return match.group(1) if match else None


def antigravity_processes():
    if os.name == "nt":
        return []
    try:
        output = subprocess.run(
            ["ps", "-ax", "-o", "uid=,pid=,command="],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    processes = []
    for line in output.splitlines():
        match = re.match(r"\s*(\d+)\s+(\d+)\s+(.+)", line)
        if not match:
            continue
        uid, pid, command = int(match.group(1)), int(match.group(2)), match.group(3)
        if hasattr(os, "getuid") and uid != os.getuid():
            continue
        lower = command.lower()
        cli = bool(re.search(r"(?:^|[/\\])(agy|antigravity-cli|antigravity_cli)(?:\s|$)", lower))
        server = "language_server" in lower or "language-server" in lower
        if not cli and not (server and "antigravity" in lower):
            continue
        csrf = extract_flag(command, "--csrf_token")
        extension_port = extract_flag(command, "--extension_server_port")
        extension_csrf = extract_flag(command, "--extension_server_csrf_token")
        processes.append({
            "pid": pid,
            "csrf": csrf,
            "extension_port": int(extension_port) if extension_port and extension_port.isdigit() else None,
            "extension_csrf": extension_csrf,
        })
    return processes


def listening_ports(pid):
    lsof = next((item for item in ("/usr/sbin/lsof", "/usr/bin/lsof", shutil.which("lsof")) if item and Path(item).exists()), None)
    if not lsof:
        return []
    try:
        output = subprocess.run(
            [lsof, "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return sorted({int(port) for port in re.findall(r":(\d+)\s+\(LISTEN\)", output)})


def local_post(url, csrf=None):
    headers = {"Content-Type": "application/json", "Connect-Protocol-Version": "1"}
    if csrf:
        headers["X-Codeium-Csrf-Token"] = csrf
    request = urllib.request.Request(
        url,
        data=b'{"forceRefresh":true}',
        headers=headers,
        method="POST",
    )
    context = ssl._create_unverified_context()
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=context))
    try:
        with opener.open(request, timeout=5) as response:
            return json.load(response)
    except (OSError, ValueError, urllib.error.HTTPError):
        return None


def fetch_antigravity_local():
    path = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
    for process in antigravity_processes():
        endpoints = []
        if process["extension_port"]:
            endpoints.append(("http", process["extension_port"], process["extension_csrf"] or process["csrf"]))
        for port in listening_ports(process["pid"]):
            endpoints.extend((("https", port, process["csrf"]), ("http", port, process["csrf"])))
        for scheme, port, csrf in endpoints:
            payload = local_post(f"{scheme}://127.0.0.1:{port}{path}", csrf)
            if not payload or payload.get("code") == "unauthenticated":
                continue
            try:
                return {"plan": "Google AI", "windows": parse_antigravity(payload)}
            except ProviderError:
                continue
    raise ProviderError("nologin")


def fetch_gemini():
    binary = antigravity_binary()
    if binary:
        try:
            return fetch_antigravity_cli(binary)
        except ProviderError as cli_error:
            try:
                return fetch_antigravity_local()
            except ProviderError:
                raise cli_error
    return fetch_antigravity_local()


FETCHERS = {
    "claude": fetch_claude,
    "codex": fetch_codex,
    "gemini": fetch_gemini,
}
