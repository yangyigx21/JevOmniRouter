#!/usr/bin/env python3
"""收集 apply 阶段变更源文件，兼容 direct 与 playbook 两种模式。"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass(frozen=True)
class Change:
    status: str
    path: str
    reason: str


@dataclass(frozen=True)
class RepoInfo:
    name: str
    path: str


EXCLUDE_PREFIXES = (".ai-runner/",)
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
ARCHIVABLE_STATUSES = {"added", "modified", "renamed"}


def run(cmd: list[str], cwd: Path) -> str:
    return subprocess.run(cmd, cwd=str(cwd), text=True, capture_output=True, check=False).stdout


def norm(path: str) -> str:
    p = path.strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return p.lstrip("/")


GIT_PREFIX = re.compile(r"^[MADR]\s+")


def parse_manifest_line(raw: str) -> str | None:
    """从 written-files.txt 的一行提取路径；空行、# 注释、分隔线返回 None。"""
    line = raw.strip()
    if not line or line.startswith("#"):
        return None
    if not line.replace("=", ""):
        return None
    line = norm(line)
    m = GIT_PREFIX.match(line)
    if m:
        line = line[m.end() :].strip()
    parts = line.split()
    return parts[0] if parts else None


def load_repos(workspace: Path) -> list[RepoInfo]:
    """运行时从 project-profile.yaml 读取仓库列表；缺失则回退为扫描 workspace 中含 .git 的一级子目录。"""
    profile = workspace / "project-profile.yaml"
    if profile.exists():
        try:
            import yaml  # type: ignore

            data = yaml.safe_load(profile.read_text(encoding="utf-8")) or {}
            repos = []
            for item in data.get("repositories", []) or []:
                name = str(item.get("name") or "").strip()
                path = norm(str(item.get("path") or name))
                if name and path:
                    repos.append(RepoInfo(name=name, path=path.rstrip("/")))
            if repos:
                return repos
            print(
                "warn: project-profile.yaml exists but contains no repositories[]; "
                "falling back to workspace .git scan",
                file=sys.stderr,
            )
        except Exception as exc:
            print(
                f"warn: failed to read project-profile.yaml repositories ({exc}); "
                "falling back to workspace .git scan",
                file=sys.stderr,
            )
    else:
        print(
            "warn: project-profile.yaml not found; falling back to workspace .git scan",
            file=sys.stderr,
        )

    fallback: list[RepoInfo] = []
    for child in sorted(workspace.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if (child / ".git").exists():
            fallback.append(RepoInfo(name=child.name, path=child.name))
    return fallback


def repo_roots(repos: list[RepoInfo]) -> list[str]:
    return sorted({repo.path for repo in repos}, key=len, reverse=True)


def repo_for_path(path: str, repos: list[RepoInfo]) -> str:
    p = norm(path)
    for root in repo_roots(repos):
        if p == root or p.startswith(root + "/"):
            return root
    parts = p.split("/")
    return parts[0] if parts else "workspace-root"


def path_in_repo(path: str, repos: list[RepoInfo]) -> bool:
    p = norm(path)
    return any(p == root or p.startswith(root + "/") for root in repo_roots(repos))


def layer_for(path: str) -> str:
    p = path.lower()
    name = Path(path).name.lower()
    if p.endswith(".sql") or "/sql/" in p:
        return "DB/DDL"
    if any(x in p for x in ["/bo/", "/ivalues/", "/dto/", "/vo/"]) or name.endswith("bean.java"):
        return "Entity/BO/IValue"
    if "/dao/" in p or "mapper" in p or name.endswith("engine.java"):
        return "DAO/Repository"
    if "/task/" in p or "/et/" in p or "task" in name:
        return "BSV-Task/ET"
    if "/csfsrc/" in p or "/adapter/" in p or "csvimpl" in name:
        return "BSV-CSF/API"
    if "serviceimpl" in name or "/service/impl/" in p:
        return "BSV-Service"
    if any(x in p for x in ["/src/router", "/router/", "/menu/"]):
        return "Frontend-Route"
    if any(x in p for x in ["/src/api", "/api/"]):
        return "Frontend-API"
    if any(x in p for x in [".vue", "/components/", "/view/"]):
        return "Frontend-Component"
    if any(x in p for x in ["/test", "/tests", "/report", "/runner"]):
        return "Test/Runner/Report"
    return "Other"


def excluded(path: str, change: str) -> bool:
    p = norm(path)
    return (
        any(p.startswith(prefix) for prefix in EXCLUDE_PREFIXES)
        or p.startswith(".ai-sdd/")
        or p.startswith("openspec/")
        or p.startswith(f".ai-sdd/artifacts/changes/{change}/")
    )


def source_exclusion_reason(item: Change, change_name: str, repos: list[RepoInfo]) -> str:
    p = norm(item.path)
    if not p:
        return "empty path"
    if item.status not in ARCHIVABLE_STATUSES:
        return "only added/modified/renamed source files are archived"
    if excluded(p, change_name):
        return "not source code or generated artifact path"
    if not path_in_repo(p, repos):
        return "outside configured source repositories"
    if Path(p).suffix.lower() not in SOURCE_SUFFIXES:
        return "not a recognized source file type"
    return ""


def filter_source_changes(
    changes: list[Change], change_name: str, repos: list[RepoInfo]
) -> tuple[list[Change], list[tuple[Change, str]]]:
    result: dict[str, Change] = {}
    omitted: list[tuple[Change, str]] = []
    for item in changes:
        reason = source_exclusion_reason(item, change_name, repos)
        if reason:
            omitted.append((item, reason))
            continue
        result[item.path] = item
    return list(result.values()), omitted


def parse_file_arg(raw: str) -> Change:
    if ":" in raw and raw.split(":", 1)[0] in {"added", "modified", "deleted", "renamed", "generated"}:
        status, path = raw.split(":", 1)
    else:
        status, path = "modified", raw
    return Change(status, norm(path), "explicit-list")


def from_changed_json(path: Path) -> list[Change]:
    data = json.loads(path.read_text(encoding="utf-8"))
    changes: list[Change] = []
    for status in ("added", "modified", "deleted", "renamed"):
        values = data.get(status, [])
        if isinstance(values, dict):
            values = values.values()
        for item in values:
            changes.append(Change(status, norm(str(item)), "runner-session"))
    return changes


def git_roots(workspace: Path) -> list[Path]:
    roots = []
    if (workspace / ".git").exists():
        roots.append(workspace)
    for child in workspace.iterdir():
        if child.is_dir() and (child / ".git").exists():
            roots.append(child)
    return roots or [workspace]


def from_git(workspace: Path) -> list[Change]:
    changes: list[Change] = []
    seen: set[str] = set()
    for root in git_roots(workspace):
        out = run(["git", "status", "--porcelain=v1", "-uall"], root)
        prefix = "" if root == workspace else root.relative_to(workspace).as_posix() + "/"
        for line in out.splitlines():
            if not line:
                continue
            code = line[:2]
            raw_path = line[3:]
            status = "modified"
            if code == "??" or "A" in code:
                status = "added"
            if "D" in code:
                status = "deleted"
            if "R" in code:
                status = "renamed"
                raw_path = raw_path.split(" -> ")[-1]
            rel = norm(prefix + raw_path)
            if rel not in seen:
                seen.add(rel)
                changes.append(Change(status, rel, "git-status"))
    return changes


def dedupe(changes: list[Change]) -> list[Change]:
    result: dict[str, Change] = {}
    for item in changes:
        if not item.path:
            continue
        result[item.path] = item
    return list(result.values())


def copy_snapshots(workspace: Path, out_dir: Path, changes: list[Change]) -> dict[str, str]:
    snapshot_dir = out_dir / "changed-files"
    if snapshot_dir.exists():
        shutil.rmtree(snapshot_dir)
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    snapshots: dict[str, str] = {}
    for item in changes:
        src = workspace / item.path
        if item.status == "deleted" or not src.exists() or not src.is_file():
            snapshots[item.path] = "(deleted)" if item.status == "deleted" else "(missing)"
            continue
        dest = snapshot_dir / item.path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        snapshots[item.path] = dest.relative_to(out_dir).as_posix()
    return snapshots


def display_path(path: Path, workspace: Path) -> str:
    try:
        return path.relative_to(workspace).as_posix()
    except ValueError:
        return path.as_posix()


def write_manifest(
    out_dir: Path,
    workspace: Path,
    change: str,
    changes: list[Change],
    snapshots: dict[str, str],
    omitted: list[tuple[Change, str]],
    repos: list[RepoInfo],
) -> None:
    counts = {key: 0 for key in ("added", "modified", "renamed")}
    for item in changes:
        counts[item.status] = counts.get(item.status, 0) + 1
    sources = sorted({item.reason for item in changes})
    lines = [
        f"# 变更文件清单：{change}",
        "",
        f"- 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"- 来源：{' + '.join(sources) if sources else 'unavailable'}",
        f"- 变更文件归档目录：`{display_path(out_dir / 'changed-files', workspace)}/`",
        "- 归档口径：仅本次编码任务新增/修改/重命名后的源代码文件；`.ai-sdd/`、`openspec/`、报告、备份、runner、历史 artifacts 等不归档。",
        "",
        "## 汇总",
        "| 状态 | 数量 |",
        "|---|---:|",
    ]
    lines += [f"| {key} | {counts.get(key, 0)} |" for key in ("added", "modified", "renamed")]
    lines += [
        "",
        "## 文件列表",
        "| 状态 | 文件路径 | 归档副本 | 来源/原因 |",
        "|---|---|---|---|",
    ]
    if changes:
        for item in changes:
            lines.append(f"| {item.status} | `{item.path}` | `{snapshots[item.path]}` | {item.reason} |")
    else:
        lines.append("| none | - | - | no source code files matched archive policy |")
    lines += [
        "",
        "## 按层次汇总",
        "| 层次 | 模块/仓库 | 状态 | 文件路径 | 任务/Trace |",
        "|---|---|---|---|---|",
    ]
    if changes:
        for item in changes:
            lines.append(f"| {layer_for(item.path)} | {repo_for_path(item.path, repos)} | {item.status} | `{item.path}` | TODO |")
    else:
        lines.append("| none | - | - | - | - |")
    lines += [
        "",
        "## 未归档候选文件",
        "| 文件路径 | 原因 |",
        "|---|---|",
    ]
    if omitted:
        for item, reason in omitted:
            lines.append(f"| `{item.path}` | {reason} |")
    else:
        lines.append("| none | - |")
    (out_dir / "changed-files.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def repo_aliases(repos: list[RepoInfo]) -> list[tuple[str, RepoInfo]]:
    aliases: list[tuple[str, RepoInfo]] = []
    for repo in repos:
        aliases.append((repo.path, repo))
        if repo.name != repo.path:
            aliases.append((repo.name, repo))
    return sorted(aliases, key=lambda item: len(item[0]), reverse=True)


def resolve_manifest_entry(line: str, repos: list[RepoInfo]) -> tuple[RepoInfo, str] | None:
    clean = norm(line)
    for alias, repo in repo_aliases(repos):
        if clean == alias or clean.startswith(alias + "/"):
            rel_path = clean[len(alias) :].lstrip("/")
            if rel_path:
                return repo, rel_path
    return None


def collect_from_manifest(
    workspace: Path,
    out_dir: Path,
    change_name: str,
    manifest: Path,
    repos: list[RepoInfo],
) -> int:
    snapshot_dir = out_dir / "changed-files"
    if snapshot_dir.exists():
        shutil.rmtree(snapshot_dir)
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    rows: list[Change] = []
    omitted: list[tuple[Change, str]] = []
    snapshots: dict[str, str] = {}
    errors = 0
    attempted = 0

    for raw in manifest.read_text(encoding="utf-8").splitlines():
        line = parse_manifest_line(raw)
        if not line:
            continue
        attempted += 1
        resolved = resolve_manifest_entry(line, repos)
        if not resolved:
            omitted.append((Change("modified", norm(line), "written-files"), "outside configured source repositories"))
            continue
        repo, rel_path = resolved
        workspace_path = norm(f"{repo.path}/{rel_path}")
        item = Change("modified", workspace_path, "written-files")
        reason = source_exclusion_reason(item, change_name, repos)
        if reason:
            omitted.append((item, reason))
            continue
        src = workspace / repo.path / rel_path
        if not src.exists() or not src.is_file():
            snapshots[item.path] = "(missing)"
            omitted.append((item, "manifest file not found on disk"))
            errors += 1
            continue
        dest = snapshot_dir / item.path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        snapshots[item.path] = dest.relative_to(out_dir).as_posix()
        rows.append(item)

    out_dir.mkdir(parents=True, exist_ok=True)
    write_manifest(out_dir, workspace, change_name, rows, snapshots, omitted, repos)
    copied = sum(1 for value in snapshots.values() if value not in {"(deleted)", "(missing)"})
    print(f"Archived {len(rows)} source files ({copied} copied) into {out_dir}; omitted {len(omitted)} candidates")
    if attempted > 0 and copied == 0:
        print(
            "error: written-files.txt has entries but no source files were archived; "
            "check paths use <repo>/<subdir>/... format",
            file=sys.stderr,
        )
        return 2
    if omitted:
        print(
            f"error: {len(omitted)} manifest entries were not archived; fix written-files.txt",
            file=sys.stderr,
        )
        for item, reason in omitted:
            print(f"  omitted: {item.path} ({reason})", file=sys.stderr)
        return 2
    return 1 if errors else 0


def collect_direct(args: argparse.Namespace, workspace: Path, out_dir: Path, repos: list[RepoInfo]) -> int:
    changes: list[Change] = []
    for item in args.file:
        changes.append(parse_file_arg(item))
    for item in args.changed_json:
        changes.extend(from_changed_json(Path(item)))
    if args.git or not changes:
        changes.extend(from_git(workspace))
    candidates = dedupe(changes)
    changes, omitted = filter_source_changes(candidates, args.change, repos)
    if len(changes) > args.max_files:
        print(f"Refusing to archive {len(changes)} files; pass explicit --file entries or raise --max-files.", file=sys.stderr)
        return 3
    out_dir.mkdir(parents=True, exist_ok=True)
    snapshots = copy_snapshots(workspace, out_dir, changes)
    write_manifest(out_dir, workspace, args.change, changes, snapshots, omitted, repos)
    copied = sum(1 for value in snapshots.values() if value not in {"(deleted)", "(missing)"})
    print(f"Archived {len(changes)} source files ({copied} copied) into {out_dir}; omitted {len(omitted)} non-source candidates")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--change", required=True)
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--output")
    parser.add_argument("--manifest")
    parser.add_argument("--changed-json", action="append", default=[])
    parser.add_argument("--file", action="append", default=[])
    parser.add_argument("--git", action="store_true")
    parser.add_argument("--max-files", type=int, default=300)
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    out_dir = Path(args.output or workspace / ".ai-sdd" / "artifacts" / "changes" / args.change).resolve()
    repos = load_repos(workspace)

    explicit_direct_input = bool(args.file or args.changed_json or args.git)
    default_manifest = out_dir / "written-files.txt"
    manifest = Path(args.manifest).resolve() if args.manifest else default_manifest
    if args.manifest:
        if not manifest.exists():
            print(f"error: manifest not found: {manifest}", file=sys.stderr)
            return 1
        return collect_from_manifest(workspace, out_dir, args.change, manifest, repos)
    if not explicit_direct_input:
        if not default_manifest.exists():
            print(
                f"error: written-files.txt missing: {default_manifest}; "
                "default collection requires the Phase 5 manifest",
                file=sys.stderr,
            )
            return 1
        return collect_from_manifest(workspace, out_dir, args.change, default_manifest, repos)

    return collect_direct(args, workspace, out_dir, repos)


if __name__ == "__main__":
    raise SystemExit(main())
