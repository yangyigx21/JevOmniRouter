#!/usr/bin/env python3
"""开发分身 — 任务分诊的确定性否决（triage）

背景：人设的「简单改动」五条标准全是模型自述的否定判断，且在读代码之前作出，
而这个判定决定是否绕过整条 SDD 流程——它是本技能包里唯一由散文独占的分叉。
本脚本把其中**可由路径判定**的部分变成确定性否决，与设计原则 1「确定性优先于自觉」对齐。

定位（重要）：本脚本只能**否决**直修，不能**批准**直修。
返回 NO-DIRECT 即必须走 SDD；返回 DIRECT-OK 只表示"路径层面没有否决项"，
其余四条标准（业务规则、可回滚性等）仍需模型判断 + 用户确认。
偏置是刻意的：误报只会多走流程（安全方向），漏报则会绕过设计。

用法：
    python3 triage.py --paths <拟改文件路径...> [--workspace .]

退出码：0 = DIRECT-OK（无路径级否决）/ 1 = NO-DIRECT（有否决项）/ 2 = 参数错误
设计约束：仅标准库；**纯只读**，不写任何文件。
"""

import argparse
import json
import os
import re
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# 路径级否决规则：(规则名, 正则, 命中说明)
# 一律对 POSIX 化后的小写路径匹配。宁可误报（多走流程）不可漏报。
VETOES = [
    ("数据库与迁移脚本",
     r"(\.sql$|/migrations?/|/seeds?/|(^|/)(flyway|liquibase)/)",
     "涉及数据库变更或迁移脚本——不可逆动作，必须走 SDD 并经同意门"),
    ("依赖与锁文件",
     r"(^|/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|build\.gradle(\.kts)?|requirements\.txt|go\.mod|go\.sum|cargo\.toml|cargo\.lock|poetry\.lock)$",
     "改动依赖清单或锁文件——引入/升级依赖，标准第 2 条不满足"),
    ("受管技能目录",
     r"(^|/)\.trae/skills/(openspec-[^/]+|_shared)/",
     "openspec-* 与 _shared 是受管目录（模板生成、整体替换分发），禁止手改"),
    ("鉴权与权限",
     r"(auth|authz|authn|permission|privilege|/acl|/rbac|security|鉴权|权限|登录|token|credential)",
     "疑似触及鉴权/权限逻辑——标准第 4 条不满足"),
    ("对外接口与契约",
     r"(controller|/api/|/apis/|route[sr]?[./]|endpoint|/dto/|contract|\.proto$|openapi|swagger|feign|/facade/)",
     "疑似触及对外接口或契约定义——标准第 1 条不满足"),
    ("数据模型",
     r"(/entity/|/entities/|/model[s]?/|/schema[s]?/|\.ddl$|/po/|/mapper/|/dao/|migration)",
     "疑似触及数据模型定义——标准第 1 条不满足"),
    ("配置开关",
     r"(feature[-_]?flag|/featureflags?/|toggles?\.|\.env($|\.)|application[-.].*\.(ya?ml|properties)$)",
     "疑似 feature flag 或环境配置——改开关可能等价于上线新功能，需人工确认是否属新增能力"),
]


def norm(p):
    """POSIX 化 + 去掉前导 ./ + 转小写。

    注意：不能用 lstrip("./")——它会剥掉任意前导的 . 与 /，
    使 ".trae/skills/..." 变成 "trae/skills/..."，让受管目录否决失效。
    """
    s = p.replace("\\", "/").strip()
    while s.startswith("./"):
        s = s[2:]
    return s.lstrip("/").lower()


def load_repo_paths(ws):
    """浅层解析 project-profile.yaml 的 repositories[].path（不引入 YAML 依赖）。"""
    prof = os.path.join(ws, "project-profile.yaml")
    if not os.path.isfile(prof):
        return []
    paths, in_repos = [], False
    with open(prof, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if re.match(r"^repositories\s*:", line):
                in_repos = True
                continue
            if in_repos:
                if re.match(r"^\S", line):
                    break
                m = re.match(r"^\s*-?\s*path\s*:\s*(\S+)", line)
                if m:
                    paths.append(norm(m.group(1).strip().strip("\"'")))
    return [p for p in paths if p]


def active_changes(ws):
    """列出非归档 change（只读目录扫描，不调 CLI，避免未初始化工作区报错）。"""
    d = os.path.join(ws, "openspec", "changes")
    if not os.path.isdir(d):
        return []
    return sorted(x for x in os.listdir(d)
                  if x != "archive" and os.path.isdir(os.path.join(d, x)))


def main():
    ap = argparse.ArgumentParser(description="任务分诊的确定性否决（只读）")
    ap.add_argument("--paths", nargs="+", required=True, help="本次拟改动的文件路径")
    ap.add_argument("--workspace", default=".")
    ap.add_argument("--text", action="store_true")
    a = ap.parse_args()

    ws = os.path.abspath(a.workspace)
    paths = [norm(p) for p in a.paths if p.strip()]
    r = {"workspace": ws, "paths": paths, "vetoes": [], "warnings": []}

    # 1) 路径级否决
    for p in paths:
        for name, pat, why in VETOES:
            if re.search(pat, p):
                r["vetoes"].append({"path": p, "rule": name, "reason": why})

    # 2) 跨仓库判定
    repos = load_repo_paths(ws)
    touched = sorted({rp for rp in repos for p in paths if p.startswith(rp.rstrip("/") + "/")})
    r["repos_declared"], r["repos_touched"] = repos, touched
    if len(touched) > 1:
        r["vetoes"].append({
            "path": ", ".join(touched), "rule": "跨仓库",
            "reason": "改动横跨多个已登记仓库——标准第 3 条不满足",
        })

    # 3) 活动 change 提示（不否决，但必须告知用户）
    ch = active_changes(ws)
    r["active_changes"] = ch
    if ch:
        r["warnings"].append(
            "工作区存在未归档 change：" + ", ".join(ch) +
            "。直修不会计入这些 change，其 tasks/verify/archive 不覆盖本次改动——"
            "必须在提示用户时点明，并让其在「纳入该 change 走 SDD」与「明确旁路直修」间选择。"
            "直修模式一律不得勾选 tasks（会制造反向假绿）。")

    r["decision"] = "NO-DIRECT" if r["vetoes"] else "DIRECT-OK"
    r["note"] = ("本脚本只能否决直修、不能批准直修：DIRECT-OK 仅表示路径层面无否决项，"
                 "其余标准仍需模型判断与用户确认；拿不准一律走 SDD。")

    if a.text:
        print("decision : " + r["decision"])
        print("paths    : " + ", ".join(paths))
        for v in r["vetoes"]:
            print("VETO     : [{rule}] {path} — {reason}".format(**v))
        for w in r["warnings"]:
            print("WARN     : " + w)
        print("NOTE     : " + r["note"])
    else:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    return 1 if r["vetoes"] else 0


if __name__ == "__main__":
    sys.exit(main())
