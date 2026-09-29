#!/usr/bin/env python3
"""开发分身 — 续作台账保全与合流（ledger）

背景（本脚本存在的唯一理由）：
ai-apply-change 的 direct Phase 1.2 步骤 2 与 playbook Step 1 都会在开工前
`rm -rf .ai-sdd/artifacts/changes/<change>/`（脚本侧 create_backup.py 亦
`shutil.rmtree`）。该目录是**轮次级**的，而一个 27–90 任务的 change 往往需要多轮
会话才能做完。于是第 2 轮起，上一轮的 written-files.txt / coding-assumptions.md /
human-config-checklist.md / review-notes.md 会离线，导致：
  · Phase 5.5 占位扫描扫不到前几轮写过的文件；
  · Phase 6 collect_changed_files.py 只归档最后一轮的源码快照；
  · 未关闭的 ASM-* 假设与 CFG-* 人工配置项跨轮丢失（生产风险）。

本脚本把台账从「轮次级」提升为「change 级累积」，且不修改任何被包裹技能：
  snapshot  委托 apply 技能**之前**调用，把当前台账存到清空动作够不着的位置
  merge     apply 产出之后调用，把历轮台账并回本轮 written-files.txt 等文件
  status    只读盘点

用法：
    python3 ledger.py snapshot --change <name> [--workspace .]
    python3 ledger.py merge    --change <name> [--workspace .]
    python3 ledger.py status   --change <name> [--workspace .]

退出码：0 成功 / 1 需要人工介入 / 2 脚本错误
设计约束：仅标准库（不依赖 unzip，Windows 可用）；不动源码；不调用 aispec CLI。
"""

import argparse
import json
import os
import shutil
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# 行清单型台账：按行取并集去重
LINE_LEDGERS = ["written-files.txt"]
# 追加型台账：按轮次分节拼接，保留全部历史条目
APPEND_LEDGERS = ["coding-assumptions.md", "human-config-checklist.md", "review-notes.md"]


def artifact_dir(ws, change):
    return os.path.join(ws, ".ai-sdd", "artifacts", "changes", change)


def carryover_dir(ws, change):
    """存放跨轮台账的位置。

    刻意放在 <change>/ **之外**（同级），因为清空动作的目标是 <change>/ 本身，
    放在里面会被一起删掉。
    """
    return os.path.join(ws, ".ai-sdd", "artifacts", "changes", change + ".carryover")


def read_lines(path):
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8", errors="replace") as fh:
        return [ln.rstrip("\n") for ln in fh]


def meaningful(lines):
    return [ln for ln in lines if ln.strip() and not ln.lstrip().startswith("#")]


def next_round(co_dir):
    if not os.path.isdir(co_dir):
        return 1
    ns = [int(d.split("-")[1]) for d in os.listdir(co_dir)
          if d.startswith("round-") and d.split("-")[-1].isdigit()]
    return (max(ns) + 1) if ns else 1


def cmd_snapshot(ws, change):
    ad, co = artifact_dir(ws, change), carryover_dir(ws, change)
    out = {"action": "snapshot", "change": change}
    if not os.path.isdir(ad):
        out.update(result="not-needed", reason="台账目录不存在（首轮会话）", round=0)
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0

    rnd = next_round(co)
    dest = os.path.join(co, f"round-{rnd}")
    os.makedirs(dest, exist_ok=True)
    saved = []
    for name in LINE_LEDGERS + APPEND_LEDGERS:
        src = os.path.join(ad, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(dest, name))
            saved.append(name)
    out.update(result="ok", round=rnd, saved=saved, carryover=dest,
               note="已保全到清空动作够不着的位置；apply 结束后必须执行 merge")
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


def cmd_merge(ws, change):
    ad, co = artifact_dir(ws, change), carryover_dir(ws, change)
    out = {"action": "merge", "change": change, "merged": {}, "needs_attention": []}
    if not os.path.isdir(co):
        out.update(result="not-needed", reason="无历轮台账（首轮会话）")
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0
    if not os.path.isdir(ad):
        out.update(result="error", reason=f"本轮台账目录不存在：{ad}")
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 1

    rounds = sorted(d for d in os.listdir(co) if d.startswith("round-"))

    # 1) 行清单：历轮 ∪ 本轮，保持首次出现顺序；对已不存在的路径给出提示而非静默丢弃
    for name in LINE_LEDGERS:
        seen, merged, missing = set(), [], []
        for r in rounds:
            for ln in meaningful(read_lines(os.path.join(co, r, name))):
                if ln not in seen:
                    seen.add(ln)
                    merged.append(ln)
        cur = os.path.join(ad, name)
        for ln in meaningful(read_lines(cur)):
            if ln not in seen:
                seen.add(ln)
                merged.append(ln)
        for ln in merged:
            # written-files.txt 的条目形如 <仓库>/<路径>，逐条核对磁盘是否仍存在
            if not os.path.exists(os.path.join(ws, ln)):
                missing.append(ln)
        if merged:
            with open(cur, "w", encoding="utf-8", newline="\n") as fh:
                fh.write("\n".join(merged) + "\n")
        out["merged"][name] = {"lines": len(merged), "rounds": len(rounds)}
        if missing:
            out["needs_attention"].append({
                "file": name, "missing_on_disk": missing[:20],
                "hint": "历轮登记但当前磁盘不存在（被删除或改名）；"
                        "collect_changed_files.py 会失败，需在 apply-report 说明后从清单剔除",
            })

    # 2) 追加型：历轮内容以轮次分节前置，避免 ASM-*/CFG-* 跨轮丢失
    for name in APPEND_LEDGERS:
        blocks = []
        for r in rounds:
            body = "\n".join(read_lines(os.path.join(co, r, name))).strip()
            if body:
                blocks.append(f"<!-- carryover: {r} -->\n{body}")
        if not blocks:
            continue
        cur = os.path.join(ad, name)
        current = "\n".join(read_lines(cur)).strip()
        if current:
            blocks.append("<!-- carryover: current-round -->\n" + current)
        with open(cur, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n\n".join(blocks) + "\n")
        out["merged"][name] = {"rounds_merged": len(blocks)}

    out["result"] = "ok"
    out["next_step"] = ("重跑 collect_changed_files.py（它按 written-files.txt 重建快照，"
                        "本身幂等），使 changed-files/ 覆盖全部轮次")
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 1 if out["needs_attention"] else 0


def cmd_status(ws, change):
    ad, co = artifact_dir(ws, change), carryover_dir(ws, change)
    rounds = sorted(d for d in os.listdir(co)) if os.path.isdir(co) else []
    cur_lines = meaningful(read_lines(os.path.join(ad, "written-files.txt")))
    print(json.dumps({
        "action": "status", "change": change,
        "artifact_dir_exists": os.path.isdir(ad),
        "current_written_files": len(cur_lines),
        "carryover_rounds": rounds,
        "cumulative_round": len(rounds) + 1,
    }, ensure_ascii=False, indent=1))
    return 0


def main():
    ap = argparse.ArgumentParser(description="续作台账保全与合流")
    ap.add_argument("action", choices=["snapshot", "merge", "status"])
    ap.add_argument("--change", required=True)
    ap.add_argument("--workspace", default=".")
    a = ap.parse_args()
    ws = os.path.abspath(a.workspace)
    return {"snapshot": cmd_snapshot, "merge": cmd_merge, "status": cmd_status}[a.action](ws, a.change)


if __name__ == "__main__":
    sys.exit(main())
