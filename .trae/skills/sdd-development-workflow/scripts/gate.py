#!/usr/bin/env python3
"""开发分身 — 确定性入口门禁（gate）

把原先散落在 SKILL.md 里的自然语言纪律换成一次可执行检查，输出 JSON 决策。
覆盖：CLI 版本能力判定、任务进度自解析（不信任旧版 CLI）、会话类型判定
（fresh/resume/complete）、制品前置校验、台账现状盘点。

用法：
    python3 gate.py --change <name> [--workspace .] [--json|--text]

退出码：
    0  GO / VERIFY-ONLY（决策见 JSON 的 decision 字段）
    1  NO-GO（阻塞，理由见 reasons）
    2  脚本自身错误（CLI 不可用、参数错误等）

设计约束：仅用标准库；不修改任何文件；不调用 aispec CLI；只读 openspec CLI 与磁盘。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

# Windows 控制台默认非 UTF-8，中文输出会乱码；显式重配 stdout/stderr。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


def resolve_cli(name="openspec"):
    """解析 CLI 可执行文件。

    npm 在 Windows 上会同时生成无扩展名的 shell 脚本与 .cmd/.ps1；Python 的
    subprocess 不走 Git-Bash 的解析规则，必须用 shutil.which（它会查 PATHEXT）。
    """
    return shutil.which(name) or name

# 官方任务行正则：与 openspec 的 TASK_LINE_PATTERN 语义一致，但**不忽略缩进**。
# 旧版 CLI（<1.8.0）只匹配零缩进复选框，会漏掉子任务——本脚本自行补齐。
TASK_LINE = re.compile(r"^(\s*)[-*]\s*\[([ xX])\]\s*(.*)$")

# 能力下限：低于该版本时对应 CLI 能力不可信/不存在
CAP_MIN = {
    "trust_cli_progress": (1, 8, 0),   # 1.8.0 起 progress/state 计入缩进子任务
    "operation_guidance": (1, 7, 0),   # 1.7.0 起 instructions apply 返回 operationGuidance
    "store": (1, 5, 0),                # store 场景支持
}


def run(cmd, cwd, timeout=120):
    """运行命令，返回 (exit_code, stdout, stderr)。cmd[0] 若为 openspec 会先解析真实路径。"""
    cmd = [resolve_cli(cmd[0])] + list(cmd[1:])
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout, encoding="utf-8", errors="replace")
        return p.returncode, p.stdout or "", p.stderr or ""
    except FileNotFoundError:
        return 127, "", f"command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout: {' '.join(cmd)}"


def run_json(cmd, cwd):
    """运行命令并解析 JSON；失败返回 (None, 原始输出)。

    未初始化的工作区下 openspec 会返回人类可读错误而非 JSON，此处如实回传原文。
    """
    code, out, err = run(cmd, cwd)
    raw = (out + err).strip()
    if code != 0 and not out.strip():
        return None, raw
    try:
        return json.loads(out), raw
    except (ValueError, TypeError):
        return None, raw


def parse_version(text):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else None


def parse_tasks(path):
    """自行解析 tasks.md，缩进子任务一律计入。返回统计与未完成任务列表。"""
    if not os.path.isfile(path):
        return None
    total = complete = 0
    pending, nested_pending = [], 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for lineno, line in enumerate(fh, 1):
            m = TASK_LINE.match(line.rstrip("\n"))
            if not m:
                continue
            indent, mark, text = m.group(1), m.group(2), m.group(3).strip()
            total += 1
            if mark in ("x", "X"):
                complete += 1
            else:
                pending.append({"line": lineno, "indent": len(indent), "text": text[:120]})
                if indent:
                    nested_pending += 1
    return {
        "total": total,
        "complete": complete,
        "remaining": total - complete,
        "pending": pending,
        "nested_pending": nested_pending,
    }


def find_tasks_file(status, workspace, change):
    """定位 tasks.md：严格消费 CLI 返回值（天然覆盖 store / 多仓库场景）。

    优先级：artifactPaths.tasks.resolvedOutputPath（绝对路径，权威）
          → existingOutputPaths[0]
          → changeRoot + artifacts[].outputPath（相对 changeRoot，非工作区）
          → 约定路径（最后兜底）
    """
    if status:
        ap = (status.get("artifactPaths") or {}).get("tasks") or {}
        resolved = ap.get("resolvedOutputPath")
        if resolved:
            return resolved
        existing = ap.get("existingOutputPaths") or []
        if existing:
            return existing[0]
        root = status.get("changeRoot")
        if root:
            for art in status.get("artifacts", []) or []:
                if art.get("id") == "tasks" and art.get("outputPath"):
                    p = art["outputPath"]
                    return p if os.path.isabs(p) else os.path.join(root, p)
            return os.path.join(root, "tasks.md")
    return os.path.join(workspace, "openspec", "changes", change, "tasks.md")


def detect_mode(workspace):
    """流程探测（与 flow-detection.md 的探测表同源，纯文件证据）。"""
    ev = {}
    profile = os.path.join(workspace, "project-profile.yaml")
    ev["project-profile.yaml"] = os.path.isfile(profile)
    ev[".ai-sdd/context/context-index.yaml"] = os.path.isfile(
        os.path.join(workspace, ".ai-sdd", "context", "context-index.yaml"))

    cfg_path = os.path.join(workspace, "openspec", "config.yaml")
    rules_apply = False
    if os.path.isfile(cfg_path):
        # 只做浅层键判定，不引入 YAML 依赖：找到顶层 rules: 段后看其缩进块内是否有 apply:
        in_rules = False
        with open(cfg_path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if re.match(r"^rules\s*:", line):
                    in_rules = True
                    continue
                if in_rules:
                    if re.match(r"^\S", line):        # 回到顶层，rules 段结束
                        break
                    if re.match(r"^\s+apply\s*:", line):
                        rules_apply = True
                        break
    ev["openspec/config.yaml rules.apply"] = rules_apply

    submode = None
    if ev["project-profile.yaml"]:
        mode_val = None
        with open(profile, encoding="utf-8", errors="replace") as fh:
            in_sdd = False
            for line in fh:
                if re.match(r"^sdd\s*:", line):
                    in_sdd = True
                    continue
                if in_sdd:
                    if re.match(r"^\S", line):
                        break
                    m = re.match(r"^\s+design-mode\s*:\s*(\S+)", line)
                    if m:
                        mode_val = m.group(1).strip().strip('"\'')
                        break
        submode = "playbook" if mode_val in ("v2", "playbook") else "direct"

    if ev["project-profile.yaml"]:
        mode = "aispec-" + (submode or "direct")
    elif ev[".ai-sdd/context/context-index.yaml"] or rules_apply:
        mode = "aispec-direct"
    else:
        mode = "official"
    return mode, ev, submode


def main():
    ap = argparse.ArgumentParser(description="开发分身确定性入口门禁")
    ap.add_argument("--change", required=True)
    ap.add_argument("--workspace", default=".")
    ap.add_argument("--text", action="store_true", help="人类可读输出（默认 JSON）")
    args = ap.parse_args()

    ws = os.path.abspath(args.workspace)
    change = args.change
    r = {
        "change": change, "workspace": ws,
        "reasons": [], "warnings": [], "blocking": [],
    }

    # ---- 0.1 CLI 与版本能力 ----
    code, out, err = run(["openspec", "--version"], ws)
    if code != 0:
        print(json.dumps({"decision": "NO-GO", "reasons": [
            "openspec CLI 不可用：" + (err or out).strip()[:200]]}, ensure_ascii=False, indent=1))
        return 1
    ver = parse_version(out)
    r["cli_version"] = ".".join(map(str, ver)) if ver else (out.strip() or "unknown")
    caps = {k: bool(ver and ver >= v) for k, v in CAP_MIN.items()}
    r["capabilities"] = caps
    if not caps["trust_cli_progress"]:
        r["warnings"].append(
            f"CLI {r['cli_version']} < 1.8.0：progress/state 不计入缩进子任务，"
            "本脚本改用自解析结果，且不信任 CLI 的 all_done")
    if not caps["operation_guidance"]:
        r["warnings"].append(
            f"CLI {r['cli_version']} < 1.7.0：operations.apply.guidance 通道不存在，"
            "instructions 返回体无 operationGuidance，相关指令不适用")

    # ---- 流程探测 ----
    mode, evidence, submode = detect_mode(ws)
    r["mode"], r["mode_evidence"], r["submode"] = mode, evidence, submode

    # ---- status / instructions ----
    status, status_raw = run_json(
        ["openspec", "status", "--change", change, "--json"], ws)
    instr, instr_raw = run_json(
        ["openspec", "instructions", "apply", "--change", change, "--json"], ws)
    if status is None and instr is None:
        r["decision"] = "NO-GO"
        r["blocking"].append("无法获取 change 状态（工作区可能未初始化或 change 不存在）")
        r["reasons"].append((status_raw or instr_raw)[:300])
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return 1

    r["cli_state"] = (instr or {}).get("state")
    r["cli_progress"] = (instr or {}).get("progress")
    r["artifacts"] = {a.get("id"): a.get("status")
                      for a in (status or {}).get("artifacts", []) or []}
    r["change_root"] = (status or {}).get("changeRoot")

    # ---- 自解析任务进度（唯一可信进度源，尤其在 <1.8.0） ----
    tasks_path = find_tasks_file(status, ws, change)
    r["tasks_file"] = tasks_path
    parsed = parse_tasks(tasks_path)
    if parsed is None:
        r["decision"] = "NO-GO"
        r["blocking"].append(f"tasks.md 不存在：{tasks_path}（左边界：本分身不补写 tasks）")
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return 1
    r["parsed_progress"] = {k: parsed[k] for k in ("total", "complete", "remaining")}
    r["nested_pending"] = parsed["nested_pending"]
    r["pending_head"] = parsed["pending"][:5]

    # CLI 与自解析对账：不一致说明 CLI 漏计（旧版缩进 bug）
    cli_total = (r["cli_progress"] or {}).get("total")
    if cli_total is not None and cli_total != parsed["total"]:
        r["warnings"].append(
            f"CLI 进度与自解析不一致（CLI total={cli_total}，实际={parsed['total']}，"
            f"其中缩进未勾 {parsed['nested_pending']} 条）——以自解析为准")

    # ---- 会话类型判定：fresh / resume / complete ----
    if parsed["remaining"] == 0 and parsed["total"] > 0:
        session = "complete"
    elif parsed["complete"] > 0:
        session = "resume"
    else:
        session = "fresh"
    r["session_kind"] = session

    # ---- 台账现状（仅 aispec 模式有台账体系） ----
    ledger_dir = os.path.join(ws, ".ai-sdd", "artifacts", "changes", change)
    ledger_file = os.path.join(ledger_dir, "written-files.txt")
    ledger = {"dir_exists": os.path.isdir(ledger_dir),
              "written_files_exists": os.path.isfile(ledger_file), "lines": 0}
    if ledger["written_files_exists"]:
        with open(ledger_file, encoding="utf-8", errors="replace") as fh:
            ledger["lines"] = sum(
                1 for ln in fh if ln.strip() and not ln.lstrip().startswith("#"))
    r["ledger"] = ledger

    # ---- 制品前置校验（两模式通用，官方 CLI，零 aispec 增强） ----
    vres, vraw = run_json(
        ["openspec", "validate", change, "--strict", "--json"], ws)
    verrors, vwarns = [], []
    if vres:
        for item in vres.get("items", []) or []:
            for issue in item.get("issues", []) or []:
                entry = f"{issue.get('level', '?')}: {issue.get('message', '')}"[:200]
                (verrors if issue.get("level") == "ERROR" else vwarns).append(entry)
    r["validate"] = {"errors": verrors, "warnings": vwarns,
                     "ok": bool(vres) and not verrors}
    if verrors:
        r["blocking"].append(f"制品校验 ERROR × {len(verrors)}（需退回上游修订，本分身不改制品）")
    if vwarns:
        r["warnings"].extend(vwarns[:5])

    # ---- 决策 ----
    if r["blocking"]:
        r["decision"] = "NO-GO"
    elif session == "complete":
        r["decision"] = "VERIFY-ONLY"
        r["reasons"].append(
            "全部任务已勾选：禁止进入任何 apply 技能（避免 Phase 1.2 清空台账），直接执行本模式 verify")
    elif (instr or {}).get("state") == "blocked":
        r["decision"] = "NO-GO"
        r["blocking"].append(
            "CLI state=blocked，缺少必需 artifact：" +
            ", ".join((instr or {}).get("missingArtifacts", []) or []))
    else:
        r["decision"] = "GO"
        if session == "resume":
            nxt = (parsed["pending"][0] or {}).get("text", "")[:60]
            msg = f"续作会话：已完成 {parsed['complete']}/{parsed['total']}，下一任务从「{nxt}」起"
            # 台账保全只适用于 aispec 模式；轻量模式无 .ai-sdd 台账体系
            if mode.startswith("aispec"):
                msg += "；进入 ai-apply-change 前必须先执行 ledger.py snapshot（见 SKILL Step 0.3）"
            else:
                msg += "；轻量模式无台账，跳过 Step 0.3 保全"
            r["reasons"].append(msg)

    if args.text:
        print(f"decision : {r['decision']}")
        print(f"mode     : {r['mode']}   session: {r['session_kind']}")
        print(f"cli      : {r['cli_version']}  caps={r['capabilities']}")
        print(f"progress : 自解析 {r['parsed_progress']}  CLI {r['cli_progress']}")
        for b in r["blocking"]:
            print(f"BLOCK    : {b}")
        for w in r["warnings"]:
            print(f"WARN     : {w}")
        for s in r["reasons"]:
            print(f"NOTE     : {s}")
    else:
        print(json.dumps(r, ensure_ascii=False, indent=1))

    return 1 if r["decision"] == "NO-GO" else 0


if __name__ == "__main__":
    sys.exit(main())
