---
name: coordination-audit
description: Audit the coordination ledger, repair structural violations and report honestly what is unfinished. 审计协调台账、修复结构性问题并如实汇报未完成项。
---

# Coordination audit

Use this skill before you report that a piece of work is finished, when a session resumes work it did not start, or whenever the user asks "what is left?".

Every call takes `workspace`: the absolute repository root.

## 1. Read the state

```json
{"workspace":"C:/work/project","limit":10}
```

`coordination_status` returns goals, plans, duties, `readyTasks`, `waitingOnPeople`, `openViolations`, a derived `nextSteps` list, and the ledger's AMP chain tip:

```json
{"ledger": {"path": "…/ledger.json", "agent": "codex-coordination", "tip": "sha256:…", "count": 12, "verified": true}}
```

It is cheap and read-only — call it first.

## 2. Audit the record

```json
{"workspace":"C:/work/project","action":"audit","limit":10}
```

through `coordination_check`. The result is:

- `ok` — true only when there are no violations.
- `violations[]` — things the protocol forbids, each with `code`, `id` and `message`.
- `warnings[]` — legal but worth a look (for example an active goal with no plan).
- `summary` — counts per state plus `chain: {count, tip, verified}`.
- `ledger` — the path, agent, tip, count and a `verified` flag.
- `journal[]` — the newest AMP chain entries: `{seq, kind, payload, prev, hash}`, without the host-only `at`.

## 3. Export the artifact

```json
{"workspace":"C:/work/project","action":"snapshot"}
```

returns the strict AMP `ledger-snapshot` — `{amp, kind:"ledger-snapshot", agent, tip, count, entries}`. It refuses to export a chain that does not verify, so a returned snapshot is always a valid artifact. From a terminal, the same value can be written with `node scripts/amp-snapshot.mjs <workspace>`.

## 4. Repair, do not paper over

| code | meaning | repair |
| --- | --- | --- |
| `LEDGER_CHAIN` | a chain hash, `prev`, `seq`, `tip` or `count` does not verify | stop: the file was edited outside the tools; report it, do not "fix" hashes by hand |
| `GOAL_EDGE` / `DUTY_EDGE` / `PLAN_EDGE` | a record moved off the legal lifecycle | correct the record only through the tools; if it is impossible, say so |
| `GOAL_ARTIFACT` / `PLAN_ARTIFACT` / `*_ARTIFACT_ID` | the stored artifact no longer matches its key or its AMP shape | recreate the record; a hand-edited artifact is not a protocol object |
| `PLAN_CYCLE` / `TASK_PRE_MISSING` | dependency graph is not a DAG | recreate the plan with corrected `pre` values |
| `PLAN_DONE_WITH_TASKS` | a plan is `done` but tasks are not terminal | finish or skip the tasks, or reopen with a note |
| `PLAN_GOAL_MISSING` / `DUTY_REF_MISSING` | a reference points at a record that does not exist | recreate the link or remove it |
| `GOAL_ACHIEVED_WITH_PLAN` | a goal is `achieved` while a linked plan is open | settle the plan, or abandon the goal with an explanation |
| `DUTY_EVIDENCE_MISSING` / `DUTY_REVIEW_MISSING` | a handoff advanced without its required record | resubmit with real evidence, or reject and redo |
| `TASK_CHECK_MISSING` / `GOAL_CHECK_MISSING` / `PLAN_ABANDON_IF_MISSING` | a criterion or stop condition is missing | add it by recreating the record; a check is not optional |

The tool has no "repair" action on purpose: every state change goes through a recorded, protocol-checked transition, so the history stays honest.

If the server refuses to read the file at all with `INVALID_STATE … version 1`, the ledger predates the AMP chain. It is not migrated, because re-chaining it would destroy the evidence it carries: report the file and let the user decide whether to delete it.

## 5. Report

`coordination_protocol` action `list` reads recorded frames and receipts. Its
`validate` action checks a supplied artifact against the installed npm AMP
schemas; supplied snapshots also pass the upstream chain verifier. A recorded
receipt is an assertion about an observed operation, not an automatically
measured or authenticated result. `AMP_ARTIFACT` violations identify malformed
frame/receipt payloads; never rewrite immutable history to make the audit pass.

Report what the ledger says, in its own terms:

- what is `achieved` and which checks you observed,
- what is still `active` with its open tasks,
- which handoffs are waiting on a person,
- what you could not verify, stated plainly.

Do not describe recorded assertions as proven results. The ledger proves that a claim was made and by which declared identity — not that the work is correct.

## 中文要点

先 `status` 再 `check`：`ledger.verified` 与 `summary.chain` 是 AMP 链的校验结果，`violations` 是协议禁止的结构性问题，要按表修复而不是手改数字；`LEDGER_CHAIN` 失败说明文件被绕过工具改动，应如实报告；`action:"snapshot"` 导出严格 `ledger-snapshot`，链不通过时会拒绝导出；读到 `version 1` 拒绝说明旧格式不迁移，交给用户决定。汇报时区分「已记录」与「已证实」，说清哪些检查实际跑过、哪些还悬着。
