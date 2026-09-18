#!/usr/bin/env python3
"""Herdr Plugin Manifest and Monorepo Validator.

Validates all plugin manifests in `plugins/` against Herdr's specification.
Can also validate templates using the --include-templates flag.
"""

import argparse
import os
import re
import sys
from pathlib import Path

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        print("Error: Python 3.11+ (with tomllib) or `tomli` package is required.")
        sys.exit(1)

ID_REGEX = re.compile(r"^[A-Za-z0-9_:\.\-]+$")
LOCAL_ID_REGEX = re.compile(r"^[A-Za-z0-9_:\-]+$")
ALLOWED_PLACEMENTS = {"overlay", "popup", "split", "tab", "zoomed"}
ALLOWED_PLATFORMS = {"linux", "macos", "windows"}


class ValidationResult:

    def __init__(self, plugin_dir: Path):
        self.plugin_dir = plugin_dir
        self.errors = []
        self.warnings = []

    def error(self, msg: str):
        self.errors.append(msg)

    def warn(self, msg: str):
        self.warnings.append(msg)

    @property
    def is_valid(self):
        return len(self.errors) == 0


def validate_command(
    cmd, section_name: str, item_id: str, result: ValidationResult
):
    if not isinstance(cmd, list):
        result.error(
            f"{section_name} '{item_id}' `command` must be an array of strings (argv format), got {type(cmd).__name__}."
        )
        return False
    if len(cmd) == 0:
        result.error(
            f"{section_name} '{item_id}' `command` array cannot be empty."
        )
        return False
    for i, part in enumerate(cmd):
        if not isinstance(part, str):
            result.error(
                f"{section_name} '{item_id}' `command[{i}]` must be a string, got {type(part).__name__}."
            )
            return False
    return True


def validate_plugin(plugin_dir: Path) -> ValidationResult:
    result = ValidationResult(plugin_dir)
    manifest_path = plugin_dir / "herdr-plugin.toml"

    if not manifest_path.is_file():
        result.error("Missing required `herdr-plugin.toml` manifest.")
        return result

    try:
        with open(manifest_path, "rb") as f:
            data = tomllib.load(f)
    except Exception as e:
        result.error(f"Failed to parse TOML manifest: {e}")
        return result

    # 1. Top-level required fields
    required_fields = ["id", "name", "version", "min_herdr_version"]
    for field in required_fields:
        if field not in data:
            result.error(f"Missing required top-level key `{field}`.")
        elif not isinstance(data[field], str) or not data[field].strip():
            result.error(f"Top-level key `{field}` must be a non-empty string.")

    plugin_id = data.get("id", "")
    if plugin_id and not ID_REGEX.match(plugin_id):
        result.error(
            f"Invalid plugin `id` '{plugin_id}'. Allowed characters: letters, digits, '.', ':', '_', '-'."
        )

    # 2. Platforms
    platforms = data.get("platforms")
    if platforms is None:
        result.warn(
            "Missing top-level `platforms` array. Herdr CLI will display a warning on link."
        )
    elif not isinstance(platforms, list):
        result.error("`platforms` must be an array of strings.")
    else:
        for p in platforms:
            if p not in ALLOWED_PLATFORMS:
                result.warn(
                    f"Unknown platform '{p}'. Recognized platforms: {', '.join(ALLOWED_PLATFORMS)}."
                )

    action_ids = set()

    # 3. [[build]]
    build_steps = data.get("build", [])
    if not isinstance(build_steps, list):
        result.error("`[[build]]` must be an array of tables.")
    else:
        for i, step in enumerate(build_steps):
            cmd = step.get("command")
            validate_command(cmd, "[[build]]", f"index {i}", result)

    # 4. [[startup]]
    startup_hooks = data.get("startup", [])
    if not isinstance(startup_hooks, list):
        result.error("`[[startup]]` must be an array of tables.")
    else:
        for i, hook in enumerate(startup_hooks):
            cmd = hook.get("command")
            validate_command(cmd, "[[startup]]", f"index {i}", result)

    # 5. [[actions]]
    actions = data.get("actions", [])
    if not isinstance(actions, list):
        result.error("`[[actions]]` must be an array of tables.")
    else:
        for action in actions:
            aid = action.get("id")
            if not aid or not isinstance(aid, str):
                result.error("Action missing required string `id`.")
                continue

            if "." in aid:
                result.error(
                    f"Action id '{aid}' must NOT contain dots (Herdr qualifies actions as `<plugin-id>.<action-id>`)."
                )
            elif not LOCAL_ID_REGEX.match(aid):
                result.error(
                    f"Action id '{aid}' contains invalid characters. Use letters, digits, colons, underscores, or hyphens."
                )

            if aid in action_ids:
                result.error(f"Duplicate action id '{aid}' in same plugin.")
            action_ids.add(aid)

            title = action.get("title")
            if not title or not isinstance(title, str):
                result.error(f"Action '{aid}' missing string `title`.")

            cmd = action.get("command")
            validate_command(cmd, "Action", aid, result)

            contexts = action.get("contexts")
            if contexts is not None and not isinstance(contexts, list):
                result.error(f"Action '{aid}' `contexts` must be a string array.")

    # 6. [[events]]
    events = data.get("events", [])
    if not isinstance(events, list):
        result.error("`[[events]]` must be an array of tables.")
    else:
        for i, event in enumerate(events):
            on = event.get("on")
            if not on or not isinstance(on, str):
                result.error(f"Event at index {i} missing string `on` property.")
            cmd = event.get("command")
            validate_command(cmd, "Event", on or f"index {i}", result)

    # 7. [[panes]]
    pane_ids = set()
    panes = data.get("panes", [])
    if not isinstance(panes, list):
        result.error("`[[panes]]` must be an array of tables.")
    else:
        for pane in panes:
            pid = pane.get("id")
            if not pid or not isinstance(pid, str):
                result.error("Pane missing required string `id`.")
                continue

            if "." in pid:
                result.error(f"Pane id '{pid}' must NOT contain dots.")
            elif not LOCAL_ID_REGEX.match(pid):
                result.error(f"Pane id '{pid}' contains invalid characters.")

            if pid in pane_ids:
                result.error(f"Duplicate pane id '{pid}' in same plugin.")
            pane_ids.add(pid)

            placement = pane.get("placement", "overlay")
            if placement not in ALLOWED_PLACEMENTS:
                result.error(
                    f"Pane '{pid}' invalid placement '{placement}'. Allowed: {', '.join(ALLOWED_PLACEMENTS)}."
                )

            cmd = pane.get("command")
            validate_command(cmd, "Pane", pid, result)

    # 8. [[link_handlers]]
    link_handlers = data.get("link_handlers", [])
    if not isinstance(link_handlers, list):
        result.error("`[[link_handlers]]` must be an array of tables.")
    else:
        for handler in link_handlers:
            hid = handler.get("id")
            if not hid or not isinstance(hid, str):
                result.error("Link handler missing required string `id`.")
                continue
            if "." in hid:
                result.error(f"Link handler id '{hid}' must NOT contain dots.")

            pattern = handler.get("pattern")
            if not pattern or not isinstance(pattern, str):
                result.error(
                    f"Link handler '{hid}' missing regex string `pattern`."
                )
            else:
                try:
                    re.compile(pattern)
                except re.error as e:
                    result.error(
                        f"Link handler '{hid}' has invalid regex pattern '{pattern}': {e}"
                    )

            target_action = handler.get("action")
            if not target_action or not isinstance(target_action, str):
                result.error(
                    f"Link handler '{hid}' missing target `action` name."
                )
            elif target_action not in action_ids:
                result.error(
                    f"Link handler '{hid}' references action '{target_action}', which is not declared in [[actions]]."
                )

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Validate Herdr plugins and manifests."
    )
    parser.add_argument(
        "--include-templates",
        action="store_true",
        help="Also validate manifests inside templates/",
    )
    parser.add_argument(
        "--path",
        type=str,
        default=None,
        help="Validate a specific plugin directory.",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent

    target_dirs = []

    if args.path:
        target = Path(args.path).resolve()
        if not target.is_dir():
            print(f"Error: Target path '{args.path}' is not a directory.")
            sys.exit(1)
        target_dirs.append(target)
    else:
        plugins_dir = repo_root / "plugins"
        if plugins_dir.is_dir():
            for p in sorted(plugins_dir.iterdir()):
                if p.is_dir() and not p.name.startswith("."):
                    target_dirs.append(p)

        if args.include_templates:
            templates_dir = repo_root / "templates"
            if templates_dir.is_dir():
                for p in sorted(templates_dir.iterdir()):
                    if p.is_dir() and not p.name.startswith("."):
                        target_dirs.append(p)

    if not target_dirs:
        print("ℹ️  No plugins found in `plugins/` to validate.")
        sys.exit(0)

    print(f"🔍 Validating {len(target_dirs)} plugin directory(ies)...\n")

    total_errors = 0
    total_warnings = 0

    for p in target_dirs:
        rel_path = p.relative_to(repo_root) if p.is_relative_to(repo_root) else p
        res = validate_plugin(p)

        if res.is_valid and not res.warnings:
            print(f"  ✅ [PASS] {rel_path}")
        elif res.is_valid:
            print(f"  ⚠️  [WARN] {rel_path}")
            for w in res.warnings:
                print(f"      - {w}")
                total_warnings += 1
        else:
            print(f"  ❌ [FAIL] {rel_path}")
            for e in res.errors:
                print(f"      - Error: {e}")
                total_errors += 1
            for w in res.warnings:
                print(f"      - Warning: {w}")
                total_warnings += 1

    print("\n" + "=" * 50)
    if total_errors == 0:
        print(
            f"🎉 All plugins validated successfully ({total_warnings} warning(s))."
        )
        sys.exit(0)
    else:
        print(
            f"💥 Validation failed with {total_errors} error(s) and {total_warnings} warning(s)."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
