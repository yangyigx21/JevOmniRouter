#!/usr/bin/env python3
"""Validate mandatory ai-apply-change playbook-mode Phase 6 artifacts."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


# 代码仓库根目录集合：运行时从 project-profile.yaml -> repositories[].path 解析。
# 缺省时按工作区顶级目录扫描 .git 目录推断。本集合不再硬编码任何项目特定仓库名。
CODE_REPO_ROOTS: set[str] = set()


def load_code_repo_roots(workspace: Path) -> set[str]:
    import re
    roots: set[str] = set()
    for filename in ("project-profile.yaml", "project-config.yaml", "project-config.yml"):
        profile = workspace / filename
        if not profile.exists():
            continue
        try:
            text = profile.read_text(encoding="utf-8")
        except OSError:
            continue
        in_repos = False
        current: dict[str, str] = {}
        items: list[dict[str, str]] = []
        for line in text.splitlines():
            if re.match(r"^repositories:\s*$", line):
                in_repos = True
                continue
            if in_repos and re.match(r"^[A-Za-z_][A-Za-z0-9_-]*:\s*", line) and not line.startswith(" "):
                break
            if not in_repos:
                continue
            m_name = re.match(r"\s*-\s+name:\s*[\"']?([^\"'#]+)", line)
            if m_name:
                if current:
                    items.append(current)
                current = {"name": m_name.group(1).strip()}
                continue
            m_key = re.match(r"\s+(path|type):\s*[\"']?([^\"'#]+)", line)
            if m_key:
                current[m_key.group(1)] = m_key.group(2).strip().strip('"').strip("'")
        if current:
            items.append(current)
        for item in items:
            p = item.get("path") or item.get("name")
            if p:
                roots.add(p.rstrip("/").split("/")[0])
        if roots:
            return roots
    for child in workspace.iterdir():
        if child.is_dir() and (child / ".git").exists() and child.name not in {"openspec", ".ai-sdd"}:
            roots.add(child.name)
    return roots
SOURCE_SUFFIXES = {
    ".bo",
    ".css",
    ".ftl",
    ".groovy",
    ".h",
    ".htm",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsp",
    ".jsx",
    ".less",
    ".properties",
    ".scss",
    ".sql",
    ".ts",
    ".tsx",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
}
REQUIRED_NONEMPTY_FILES = [
    "changed-files.md",
    "apply-report.md",
    "coding-assumptions.md",
    "human-config-checklist.md",
    "review-notes.md",
]
REQUIRED_EXISTING_FILES = REQUIRED_NONEMPTY_FILES + ["written-files.txt"]


def is_source_snapshot(path: Path) -> bool:
    parts = path.as_posix().split("/")
    return bool(parts and parts[0] in CODE_REPO_ROOTS and path.suffix.lower() in SOURCE_SUFFIXES)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--change", required=True)
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--expect-source-code", action="store_true")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    CODE_REPO_ROOTS.update(load_code_repo_roots(workspace))
    root = workspace / ".ai-sdd" / "artifacts" / "changes" / args.change
    errors: list[str] = []
    if not root.exists():
        errors.append(f"missing artifact root: {root}")
    required_paths: dict[str, Path] = {}
    for name in REQUIRED_EXISTING_FILES:
        path = root / name
        required_paths[name] = path
        if not path.is_file():
            errors.append(f"missing required file: {path}")
        elif name in REQUIRED_NONEMPTY_FILES and path.stat().st_size == 0:
            errors.append(f"empty required file: {path}")

    changed_dir = root / "changed-files"
    if not changed_dir.is_dir():
        errors.append(f"missing changed-files directory: {changed_dir}")
        snapshots: list[Path] = []
    else:
        snapshots = [path.relative_to(changed_dir) for path in changed_dir.rglob("*") if path.is_file()]
        bad = [path for path in snapshots if not is_source_snapshot(path)]
        for path in bad:
            errors.append(f"non-source file in changed-files: {path.as_posix()}")
        if args.expect_source_code and not snapshots:
            errors.append("expected source code snapshots, but changed-files is empty")
        written_files = required_paths.get("written-files.txt")
        if args.expect_source_code and written_files and written_files.is_file() and written_files.stat().st_size == 0:
            errors.append(f"empty written-files.txt while source code snapshots are expected: {written_files}")

    if errors:
        for error in errors:
            print(f"phase6-artifacts: FAIL: {error}", file=sys.stderr)
        return 2
    print(f"phase6-artifacts: OK root={root} source_snapshots={len(snapshots)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
