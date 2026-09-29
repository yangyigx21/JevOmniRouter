# Implementation Context Pack Template

仅当 `ai-apply-change` 的 playbook 模式需要为 review、复杂实现或多 Agent 协作持久化上下文时读取本模板。

## File

```text
.ai-sdd/artifacts/changes/{change-name}/apply-context-pack.md
```

## Template

```markdown
# Implementation Context Pack: {change-name}

## Scope
- Change: {change-name}
- Generated at: {YYYY-MM-DD HH:mm}
- Mode: serial | parallel

## Task Groups

### TG-{n}: {repo}/{layer}/{scenario}
- Tasks: {N.1, N.2}
- Design refs: {design.md section / D-*}
- Contracts refs: {contracts.md section | none}
- OUTBOUND contract: {loaded/diff-pass/not-applicable/BLOCKED}
- INBOUND contract: {loaded/diff-pass/not-applicable/BLOCKED}
- Change context: {path | none}
- Playbooks: {paths | none}
- Code patterns: {paths | none}
- API evidence: {api-catalog/api-drilldown/API Registry/source constants | none}
- Source/GitNexus checks: {not-needed | trigger + exact files/symbols}
- Risk/impact: {LOW/MEDIUM/HIGH/CRITICAL/not-applicable/pending}
- Coding assumptions: {ASM-001, ASM-002 | none}
- Human config: {CFG-001, CFG-002 | none}
- Review notes: {Trace gaps, design deviations, fallback conclusions}

## Cross-Task Risks
| Risk | Affected task groups | Handling |
|---|---|---|
| {risk} | {TG-n} | {handling} |

## Evidence Gaps
| Gap | Assumption id | Human validation |
|---|---|---|
| {unknown fact} | {ASM-nnn | none} | {how to validate} |
```
