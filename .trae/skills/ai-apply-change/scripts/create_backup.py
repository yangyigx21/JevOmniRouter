#!/usr/bin/env python3
"""Create ai-apply-change playbook-mode workspace and artifact zip backups."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path


# 默认仅包含 openspec；其它仓库目录运行时从 project-profile.yaml -> repositories[].path
# 加载，缺省时按工作区顶级目录中含 .git 的目录推断。本列表不再硬编码任何项目特定仓库名。
DEFAULT_WORKSPACE_INCLUDES = ["openspec"]


def load_repo_includes_from_profile(workspace: Path) -> list[str]:
    """从 project-profile.yaml -> repositories[].path 读取仓库目录清单。"""
    import re
    paths: list[str] = []
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
                paths.append(p.rstrip("/"))
        if paths:
            return paths
    fallback: list[str] = []
    for child in sorted(workspace.iterdir()):
        if child.is_dir() and (child / ".git").exists() and child.name not in {"openspec"}:
            fallback.append(child.name)
    return fallback

DEFAULT_EXCLUDE_NAMES = {
    ".git",
    ".gitnexus",
    ".gradle",
    ".idea",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
}


def timestamp(value: str | None) -> str:
    return value or datetime.now().strftime("%Y-%m-%d-%H-%M")


def rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def should_exclude(path: Path, exclude_names: set[str]) -> bool:
    return any(part in exclude_names for part in path.parts)


def iter_paths(base: Path, archive_root: Path, exclude_names: set[str], skip_file: Path | None = None):
    for current, dir_names, file_names in os.walk(base):
        current_path = Path(current)
        dir_names[:] = [name for name in dir_names if name not in exclude_names]
        if should_exclude(current_path.relative_to(archive_root), exclude_names):
            continue
        yield current_path, True
        for file_name in file_names:
            path = current_path / file_name
            if skip_file and path.resolve() == skip_file.resolve():
                continue
            if not should_exclude(path.relative_to(archive_root), exclude_names):
                yield path, False


def write_zip(target: Path, archive_base: Path, roots: list[Path], exclude_names: set[str], skip_file: Path | None = None) -> tuple[int, int]:
    target.parent.mkdir(parents=True, exist_ok=True)
    entries = 0
    total_bytes = 0
    root_set = {root.resolve() for root in roots}
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for root in roots:
            if not root.exists():
                print(f"warn: missing path skipped: {rel(root, archive_base)}", file=sys.stderr)
                continue
            for path, is_dir in iter_paths(root, archive_base, exclude_names, skip_file):
                arcname = rel(path, archive_base)
                if is_dir:
                    if path.resolve() in root_set:
                        continue
                    if arcname != ".":
                        archive.write(path, arcname.rstrip("/") + "/")
                        entries += 1
                    continue
                archive.write(path, arcname)
                entries += 1
                total_bytes += path.stat().st_size
    return entries, total_bytes


def workspace_backup(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    if args.include:
        includes = list(args.include)
    else:
        includes = list(DEFAULT_WORKSPACE_INCLUDES) + load_repo_includes_from_profile(workspace)
        seen: set[str] = set()
        deduped: list[str] = []
        for item in includes:
            if item not in seen:
                seen.add(item)
                deduped.append(item)
        includes = deduped
    roots = [(workspace / item).resolve() for item in includes]
    target = (Path(args.output).resolve() / f"backup-{timestamp(args.timestamp)}.zip")
    if target.exists():
        print(f"backup already exists: {target}", file=sys.stderr)
        return 2
    entries, total_bytes = write_zip(target, workspace, roots, set(args.exclude_name), None)
    if entries == 0:
        target.unlink(missing_ok=True)
        print("workspace-backup: not-needed (no files found)")
        return 0
    print(f"workspace-backup: {target} entries={entries} bytes={total_bytes}")
    return 0


def artifact_backup(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    changes_dir = (workspace / ".ai-sdd" / "artifacts" / "changes").resolve()
    artifact_dir = (changes_dir / args.change).resolve()
    if not artifact_dir.exists():
        print("artifact-backup: not-needed (directory missing)")
        return 0
    target = changes_dir / f"{args.change}-{timestamp(args.timestamp)}.zip"
    if target.exists():
        print(f"backup already exists: {target}", file=sys.stderr)
        return 2
    entries, total_bytes = write_zip(target, changes_dir, [artifact_dir], set(), target)
    if entries == 0:
        target.unlink(missing_ok=True)
        shutil.rmtree(artifact_dir)
        print("artifact-backup: not-needed (directory empty; old artifact directory removed)")
        return 0
    shutil.rmtree(artifact_dir)
    print(f"artifact-backup: {target} entries={entries} bytes={total_bytes}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["workspace", "artifact"], required=True)
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--timestamp")
    parser.add_argument("--exclude-name", action="append", default=sorted(DEFAULT_EXCLUDE_NAMES))
    parser.add_argument("--output", default=".")
    parser.add_argument("--include", action="append", default=[])
    parser.add_argument("--change")
    args = parser.parse_args()

    if args.mode == "artifact" and not args.change:
        parser.error("--change is required for --mode artifact")
    if args.mode == "workspace":
        return workspace_backup(args)
    return artifact_backup(args)


if __name__ == "__main__":
    raise SystemExit(main())
