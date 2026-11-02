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

`coordination_status` returns goals, plans, duties, `readyTasks`, `waitingOnPeople`, the ledger head digest, `openViolations`, and a derived `nextSteps` list. It is cheap and read-only — call it first.

## 2. Audit the record

```json
{"workspace":"C:/work/project","limit":10}
```

through `coordination_check`. The result is:

- `ok` — true only when there are no violations.
- `violations[]` — things the protocol forbids, each with `code`, `id` and `message`.
- `warnings[]` — legal but worth a look (for example an active goal with no plan).
- `summary` — counts per state plus the journal verdict.
- `journal[]` — the newest chained entries with their digests.

## 3. Repair, do not paper over

| code | meaning | repair |
| --- | --- | --- |
| `LEDGER_CHAIN` | the journal digest chain does not verify | stop: the file was edited or corrupted; report it, do not "fix" digests by hand |
| `GOAL_EDGE` / `DUTY_EDGE` / `PLAN_EDGE` | a record moved off the legal lifecycle | correct the record only through the tools; if it is impossible, say so |
| `PLAN_CYCLE` / `TASK_PRE_MISSING` | dependency graph is not a DAG | recreate the plan with corrected `pre` values |
| `PLAN_DONE_WITH_TASKS` | a plan is `done` but tasks are not terminal | finish or skip the tasks, or reopen with a note |
| `GOAL_ACHIEVED_WITH_PLAN` | a goal is `achieved` while a linked plan is open | settle the plan, or abandon the goal with an explanation |
| `DUTY_EVIDENCE_MISSING` / `DUTY_REVIEW_MISSING` | a handoff advanced without its required record | resubmit with real evidence, or reject and redo |
| `TASK_CHECK_MISSING` / `GOAL_CHECK_MISSING` | a criterion has no check | add the check by recreating the record; a check is not optional |

The tool has no "repair" action on purpose: every state change goes through a recorded, protocol-checked transition, so the history stays honest.

## 4. Report

Report what the ledger says, in its own terms:

- what is `achieved` and which checks you observed,
- what is still `active` with its open tasks,
- which handoffs are waiting on a person,
- what you could not verify, stated plainly.

Do not describe recorded assertions as proven results. The ledger proves that a claim was made and by which declared identity — not that the work is correct.

## 中文要点

先 `status` 再 `check`；`violations` 是协议禁止的结构性问题，要按表修复而不是手改数字；`LEDGER_CHAIN` 失败说明文件被绕过工具改动，应如实报告；汇报时区分「已记录」与「已证实」，说清哪些检查实际跑过、哪些还悬着。
