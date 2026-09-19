#!/usr/bin/env python3
"""Herdr entrypoint for subscription usage status, refresh, and popups."""

import contextlib
import json
import os
import re
import select
import shlex
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
from datetime import datetime
from pathlib import Path

from providers import FETCHERS, ProviderError

if os.name == "nt":
    import msvcrt
else:
    import termios
    import tty


PLUGIN_ID = "c4.usage-quote-subs"
VERSION = "0.1.0"
PROVIDERS = ("claude", "codex", "gemini")
PROVIDER_NAMES = {"claude": "Claude", "codex": "Codex", "gemini": "Gemini"}
PROVIDER_ICONS = {"claude": "\uec82", "codex": "\uec81", "gemini": "G"}

BAR_REFRESH_AGE = 300
DASHBOARD_REFRESH_AGE = 120
EVENT_REFRESH_AGE = 120
MANUAL_REFRESH_AGE = 30
FETCH_DEADLINE = 24
STALE_AFTER = 900
DEMO = os.environ.get("USAGE_QUOTE_SUBS_DEMO") == "1"


def herdr_config_dir():
    config = os.environ.get("HERDR_CONFIG_PATH")
    return Path(config).expanduser().parent if config else Path.home() / ".config" / "herdr"


def plugin_config_dir():
    configured = os.environ.get("HERDR_PLUGIN_CONFIG_DIR")
    return Path(configured) if configured else herdr_config_dir() / "plugins" / "config" / PLUGIN_ID


def plugin_state_dir():
    configured = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    return Path(configured) if configured else plugin_config_dir() / "state"


def cache_file():
    return plugin_state_dir() / "usage.json"


def lock_file():
    return plugin_state_dir() / "refresh.lock"


def load_settings():
    try:
        text = (plugin_config_dir() / "config.toml").read_text(encoding="utf-8")
    except OSError:
        return {}
    return dict(re.findall(r'^\s*([A-Za-z0-9_-]+)\s*=\s*["\']([^"\'\n]*)["\']', text, re.MULTILINE))


class Display:
    def __init__(self, settings=None):
        self.icons = (settings or {}).get("icons") == "nerd"

    def provider(self, provider):
        return f"{PROVIDER_ICONS[provider]} " if self.icons else PROVIDER_NAMES[provider]


def attempt(provider):
    now = time.time()
    try:
        reading = FETCHERS[provider]()
        return {**reading, "fetched_at": now, "attempt_at": now, "error": None, "retry_at": 0}
    except ProviderError as error:
        return {
            "attempt_at": now,
            "error": {"code": error.code, **error.params},
            "retry_at": now + error.retry_after,
        }
    except Exception as error:
        return {
            "attempt_at": now,
            "error": {"code": "unexpected", "name": type(error).__name__},
            "retry_at": 0,
        }


def fetch_due(providers):
    results = {}
    threads = [
        threading.Thread(
            target=lambda provider=provider: results.__setitem__(provider, attempt(provider)),
            daemon=True,
        )
        for provider in providers
    ]
    for thread in threads:
        thread.start()
    deadline = time.time() + FETCH_DEADLINE
    for thread in threads:
        thread.join(max(0, deadline - time.time()))
    now = time.time()
    return {
        provider: results.get(provider)
        or {"attempt_at": now, "error": {"code": "network"}, "retry_at": 0}
        for provider in providers
    }


def demo_data(now):
    hour = 3600
    day = 86400
    return {
        "claude": {
            "plan": "Max 5x",
            "fetched_at": now - 20,
            "windows": [
                {"kind": "session", "used": 21, "resets_at": now + 2 * hour + 13 * 60},
                {"kind": "weekly", "used": 47, "resets_at": now + 3 * day},
            ],
        },
        "codex": {
            "plan": "ChatGPT Plus",
            "fetched_at": now - 20,
            "windows": [
                {"kind": "session", "used": 4, "resets_at": now + 4 * hour},
                {"kind": "weekly", "used": 19, "resets_at": now + 5 * day},
            ],
        },
        "gemini": {
            "plan": "Google AI Pro",
            "fetched_at": now - 20,
            "windows": [
                {
                    "kind": "session",
                    "label": "Five Hour",
                    "model": "Gemini Models",
                    "used": 18,
                    "resets_at": now + hour + 30 * 60,
                },
                {
                    "kind": "weekly",
                    "label": "Weekly",
                    "model": "Gemini Models",
                    "used": 36,
                    "resets_at": now + 6 * day,
                },
            ],
        },
    }


def load_cache():
    if DEMO:
        return demo_data(time.time())
    try:
        data = json.loads(cache_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {provider: reading for provider, reading in data.items() if isinstance(reading, dict)}


def save_cache(data):
    target = cache_file()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=True), encoding="utf-8")
    os.replace(temporary, target)


@contextlib.contextmanager
def cache_lock():
    path = lock_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + FETCH_DEADLINE
    descriptor = None
    while descriptor is None:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > FETCH_DEADLINE * 2:
                    path.unlink()
                    continue
            except OSError:
                pass
            if time.time() >= deadline:
                raise TimeoutError("usage cache lock timed out")
            time.sleep(0.05)
    try:
        yield
    finally:
        os.close(descriptor)
        try:
            path.unlink()
        except OSError:
            pass


def refresh(max_age):
    if DEMO:
        return load_cache()
    with cache_lock():
        data = load_cache()
        now = time.time()
        due = [
            provider
            for provider in PROVIDERS
            if now - data.get(provider, {}).get("attempt_at", 0) >= max_age
            and now >= data.get(provider, {}).get("retry_at", 0)
        ]
        if not due:
            return data
        for provider in due:
            data[provider] = {**data.get(provider, {}), "attempt_at": now}
        save_cache(data)
    results = fetch_due(due)
    with cache_lock():
        data = load_cache()
        for provider, result in results.items():
            data[provider] = {**data.get(provider, {}), **result}
        save_cache(data)
        return data


def current_windows(reading, now):
    windows = reading.get("windows") if isinstance(reading.get("windows"), list) else []
    valid = []
    for window in windows:
        if not isinstance(window, dict) or not isinstance(window.get("used"), (int, float)):
            continue
        if window.get("resets_at") and window["resets_at"] <= now:
            valid.append({**window, "used": 0, "resets_at": None})
        else:
            valid.append(window)
    return valid


def provider_error(reading):
    error = reading.get("error")
    return error if isinstance(error, dict) else None


def visible_providers(data):
    return [
        provider
        for provider in PROVIDERS
        if current_windows(data.get(provider, {}), 0)
        or (provider_error(data.get(provider, {})) or {}).get("code") != "nologin"
    ]


def preferred_window(windows):
    sessions = [window for window in windows if window.get("kind") == "session"]
    if sessions:
        return max(sessions, key=lambda window: window["used"])
    weekly = [window for window in windows if window.get("kind") == "weekly"]
    if weekly:
        return max(weekly, key=lambda window: window["used"])
    return max(windows, key=lambda window: window["used"])


def window_code(window):
    return {
        "session": "5h",
        "weekly": "7d",
        "hours": f"{window.get('n')}h",
        "days": f"{window.get('n')}d",
        "quota": "quota",
    }.get(window.get("kind"), str(window.get("kind") or "quota"))


def reset_clock(timestamp, now):
    if not timestamp:
        return "?"
    reset = datetime.fromtimestamp(timestamp)
    current = datetime.fromtimestamp(now)
    return reset.strftime("%H:%M") if reset.date() == current.date() else reset.strftime("%a %H:%M")


def remaining(timestamp, now):
    seconds = max(0, int(timestamp - now))
    days, hours, minutes = seconds // 86400, seconds % 86400 // 3600, seconds % 3600 // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def status_line(data, now, display):
    entries = []
    for provider in visible_providers(data):
        reading = data.get(provider, {})
        windows = current_windows(reading, now)
        if not windows:
            entries.append(f"{display.provider(provider)} n/a")
            continue
        window = preferred_window(windows)
        stale = "~" if now - reading.get("fetched_at", 0) > STALE_AFTER else ""
        entries.append(
            f"{display.provider(provider)} {stale}{round(window['used'])}%/{window_code(window)}"
            f"->{reset_clock(window.get('resets_at'), now)}"
        )
    return " | ".join(entries)


COLORS = {
    "text": (192, 202, 245),
    "muted": (110, 118, 150),
    "track": (59, 66, 97),
    "good": (158, 206, 106),
    "warn": (224, 175, 104),
    "bad": (247, 118, 142),
    "claude": (217, 119, 87),
    "codex": (236, 236, 241),
    "gemini": (123, 170, 247),
}
ANSI = re.compile(r"\x1b\[[0-9;]*m")
CONTROL = re.compile(r"(?:\x1b\][^\x07]*(?:\x07|\x1b\\))|(?:\x1b\[[0-?]*[ -/]*[@-~])|[\x00-\x1f\x7f]")


def safe_text(value, limit=80):
    text = CONTROL.sub(" ", str(value or ""))
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: max(1, limit - 1)].rstrip() + "~"


def color(name, text):
    return "\x1b[38;2;%d;%d;%dm%s\x1b[39m" % (*COLORS[name], text)


def bold(text):
    return f"\x1b[1m{text}\x1b[22m"


def severity(percent):
    return "good" if percent < 50 else "warn" if percent < 80 else "bad"


def text_width(text):
    return sum(2 if unicodedata.east_asian_width(char) in "WF" else 1 for char in ANSI.sub("", text))


def aligned(left, right, width):
    return "  " + left + " " * max(1, width - 4 - text_width(left) - text_width(right)) + right


def window_label(window):
    label = safe_text(window.get("label") or window_code(window), 30)
    model = safe_text(window.get("model"), 30)
    return f"{model}: {label}" if model else label


def metric_row(window, now, width):
    percent = window["used"]
    bar_width = max(8, width - 50)
    filled = max(1 if percent > 0 else 0, round(bar_width * min(100, percent) / 100))
    bar = color(severity(percent), "=" * filled) + color("track", "-" * (bar_width - filled))
    reset = ""
    if window.get("resets_at"):
        reset = f"{remaining(window['resets_at'], now)} / {reset_clock(window['resets_at'], now)}"
    label = window_label(window)
    if len(label) > 20:
        label = label[:19] + "~"
    return f"    {color('muted', label.ljust(20))} {bar} {round(percent):>3}%  {color('muted', reset)}"


def provider_metric_rows(provider, windows, now, width):
    if provider != "gemini":
        return [metric_row(window, now, width) for window in windows]
    rows = []
    groups = []
    for window in windows:
        group = safe_text(window.get("model") or "Gemini", 36)
        if group not in groups:
            groups.append(group)
    for group in groups:
        rows.append(f"    {bold(color('muted', group))}")
        for window in windows:
            if safe_text(window.get("model") or "Gemini", 36) == group:
                rows.append(metric_row({**window, "model": None}, now, width))
    return rows


ERROR_TEXT = {
    "expired": "Login expired; open {client} to renew it",
    "limited": "Rate limited; retrying later",
    "http": "HTTP {status}",
    "network": "Network error",
    "format": "Unexpected provider response",
    "nologin": "Not logged in",
    "unexpected": "Unexpected error: {name}",
}


def format_error(error):
    template = ERROR_TEXT.get(error.get("code"), "Provider error: {code}")
    try:
        return template.format(**error)
    except (KeyError, ValueError):
        return str(error.get("code"))


def dashboard_lines(data, now, compact, busy, width, display):
    mode = "compact" if compact else "detail"
    lines = [aligned(color("muted", "Subscription usage"), color("muted", f"{mode} | r refresh"), width), ""]
    for provider in visible_providers(data):
        reading = data.get(provider, {})
        windows = current_windows(reading, now)
        title = bold(color(provider, PROVIDER_NAMES[provider]))
        plan = color("muted", safe_text(reading.get("plan"), 24))
        if windows:
            headline = preferred_window(windows)
            right = bold(color(severity(headline["used"]), f"{round(headline['used']):>3}%/{window_code(headline)}"))
            lines.append(aligned(f"{title}  {plan}", right, width))
            if not compact:
                lines.extend(provider_metric_rows(provider, windows, now, width))
        else:
            lines.append(aligned(f"{title}  {plan}", color("muted", "loading" if busy else "n/a"), width))
        error = provider_error(reading)
        if error and (not compact or not windows):
            lines.append(f"    {color('bad', '! ' + format_error(error))}")
        if not compact:
            lines.append("")
    timestamps = [
        data[provider]["fetched_at"]
        for provider in PROVIDERS
        if data.get(provider, {}).get("fetched_at")
    ]
    update = "refreshing" if busy else f"updated {remaining(time.time(), min(timestamps))} ago" if timestamps else ""
    lines.append("  " + color("muted", " | ".join(item for item in (update, "Tab view", "r refresh", "q close") if item)))
    return lines


class TerminalScreen:
    def __enter__(self):
        self.fd = sys.stdin.fileno()
        self.saved = None
        if os.name != "nt":
            self.saved = termios.tcgetattr(self.fd)
            tty.setcbreak(self.fd)
        sys.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l")
        return self

    def __exit__(self, *error):
        sys.stdout.write("\x1b[?7h\x1b[?25h\x1b[?1049l")
        sys.stdout.flush()
        if os.name != "nt":
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)
        return bool(error[0] is KeyboardInterrupt)

    def draw(self, lines):
        _, height = os.get_terminal_size()
        footer = lines[-1]
        visible = (lines[:-1] + [""] * height)[: height - 1] + [footer]
        sys.stdout.write("\x1b[H" + "\r\n".join(line + "\x1b[K" for line in visible))
        sys.stdout.flush()

    def key(self, timeout):
        if os.name == "nt":
            end = time.time() + timeout
            while time.time() < end:
                if msvcrt.kbhit():
                    return msvcrt.getch()
                time.sleep(0.02)
            return b""
        return os.read(self.fd, 32) if select.select([self.fd], [], [], timeout)[0] else b""


QUIT_KEYS = (b"q", b"Q", b"\x1b", b"\x03")


def dashboard(display):
    ui = {"compact": False, "busy": False}

    def start_refresh(max_age):
        if ui["busy"]:
            return
        ui["busy"] = True

        def worker():
            try:
                refresh(max_age)
            finally:
                ui["busy"] = False

        threading.Thread(target=worker, daemon=True).start()

    with TerminalScreen() as screen:
        start_refresh(DASHBOARD_REFRESH_AGE)
        last_refresh = time.time()
        while True:
            now = time.time()
            if now - last_refresh >= DASHBOARD_REFRESH_AGE:
                start_refresh(DASHBOARD_REFRESH_AGE)
                last_refresh = now
            screen.draw(dashboard_lines(load_cache(), now, ui["compact"], ui["busy"], os.get_terminal_size()[0], display))
            key = screen.key(0.5)
            if key in QUIT_KEYS:
                return
            if key in (b"r", b"R"):
                start_refresh(MANUAL_REFRESH_AGE)
                last_refresh = time.time()
            elif key in (b"\t", b"\x1b[Z", b"\x1b[C", b"\x1b[D"):
                ui["compact"] = not ui["compact"]


def install_status_command():
    destination = plugin_config_dir() / ("status.cmd" if os.name == "nt" else "status.sh")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    if os.name == "nt":
        temporary.write_text(
            "@echo off\r\n"
            f"set \"HERDR_PLUGIN_CONFIG_DIR={plugin_config_dir()}\"\r\n"
            f"set \"HERDR_PLUGIN_STATE_DIR={plugin_state_dir()}\"\r\n"
            f"python {subprocess.list2cmdline([str(Path(__file__).resolve()), 'status'])}\r\n",
            encoding="utf-8",
        )
    else:
        environment = (
            f"HERDR_PLUGIN_CONFIG_DIR={shlex.quote(str(plugin_config_dir()))} "
            f"HERDR_PLUGIN_STATE_DIR={shlex.quote(str(plugin_state_dir()))} "
        )
        temporary.write_text(
            "#!/bin/sh\n"
            "# Generated by Usage Quote Subs.\n"
            f"exec env {environment}python3 {shlex.quote(str(Path(__file__).resolve()))} status\n",
            encoding="utf-8",
        )
        temporary.chmod(0o755)
    os.replace(temporary, destination)
    return destination


def config_snippet(status_command):
    command = shlex.quote(str(status_command))
    return (
        "[ui]\n"
        'tab_bar_position = "bottom"  # optional\n'
        "tab_bar_right = [\n"
        f'  {{ type = "command", command = {json.dumps(command)}, interval_seconds = 15, timeout_seconds = 30 }},\n'
        "]\n\n"
        "[[keys.command]]\n"
        'key = "prefix+u"\n'
        'type = "plugin_action"\n'
        f'command = "{PLUGIN_ID}.open"\n'
        'description = "subscription usage"\n'
    )


def copy_to_clipboard(text):
    for command in (["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "-b", "-i"], ["clip"]):
        if shutil.which(command[0]):
            return subprocess.run(command, input=text, text=True, check=False).returncode == 0
    return False


def setup_popup():
    snippet = config_snippet(install_status_command())
    note = ""
    with TerminalScreen() as screen:
        while True:
            lines = [
                f"  Add this to {herdr_config_dir() / 'config.toml'}:",
                "",
                *[f"  {line}" for line in snippet.splitlines()],
                "",
                f"  {note}",
                "  c copy | q close",
            ]
            screen.draw(lines)
            key = screen.key(1)
            if key in QUIT_KEYS:
                return
            if key in (b"c", b"C"):
                note = "Copied" if copy_to_clipboard(snippet) else "No clipboard tool found"


def open_popup(entrypoint):
    herdr = os.environ.get("HERDR_BIN_PATH") or "herdr"
    return subprocess.run(
        [herdr, "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", entrypoint],
        check=False,
    ).returncode


def handle_event():
    try:
        event = json.loads(os.environ.get("HERDR_PLUGIN_EVENT_JSON") or "{}")
    except ValueError:
        return
    if event.get("agent_status") not in (None, "working"):
        refresh(EVENT_REFRESH_AGE)


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    display = Display(load_settings())
    if command == "status":
        print(status_line(refresh(BAR_REFRESH_AGE), time.time(), display))
    elif command == "refresh":
        print(status_line(refresh(MANUAL_REFRESH_AGE), time.time(), display))
    elif command == "dashboard":
        dashboard(display)
    elif command == "setup":
        setup_popup()
    elif command == "install-status-command":
        install_status_command()
    elif command == "event":
        handle_event()
    elif command == "open":
        entrypoint = sys.argv[2] if len(sys.argv) > 2 else "dashboard"
        raise SystemExit(open_popup(entrypoint))
    else:
        raise SystemExit(f"Unknown command: {command}")


if __name__ == "__main__":
    main()
