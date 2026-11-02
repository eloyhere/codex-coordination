---
name: coordination-handoffs
description: Assign, accept, submit and verify accountable handoffs between two declared identities. 在两个声明身份之间指派、接受、提交与验收可追溯的交接。
---

# Coordination handoffs

Use this skill when work moves between two identities: a parent session handing a slice to a subagent, a reviewer taking over a branch, or a later session picking up an unfinished duty. A handoff has an **owner** who accepts the result and an **assignee** who produces it.

Every call takes `workspace`: the absolute repository root.

## Inspect first

```json
{"action":"list","workspace":"C:/work/project"}
```

The response lists duties plus `waitingOnPeople` — the queue of who owes what right now. Reuse an existing duty instead of duplicating it.

## Assign

```json
{
  "action": "assign",
  "workspace": "C:/work/project",
  "duty": {
    "id": "review-readme",
    "role": "qualification",
    "owner": "codex-main",
    "assignee": "codex-sub-1",
    "responsibilities": ["Run every command in README.md and report the ones that fail"],
    "acceptance": ["Each README command is either executed successfully or reported with its error"],
    "plan": "export-plan",
    "task": "compare-digests"
  }
}
```

- `role` is one of `decision`, `outcome`, `resource`, `personnel`, `qualification`, `execution`. It is metadata; it grants nothing.
- `owner` and `assignee` are **declared identities** — use stable names (`codex-main`, `codex-sub-1:review`, a session id). They must differ.
- `responsibilities` and `acceptance` are non-empty string arrays; write each item so a reviewer can tell whether it was met.
- Optional `goal`, `plan` or `plan` + `task` references are validated against the ledger. Do not invent links.
- Assigning records the work; it does not start the assignee. Tell it separately, through your normal channel.

## Move it

Assignee side:

```json
{"action":"accept","workspace":"C:/work/project","id":"review-readme","actor":"codex-sub-1"}
{"action":"start","workspace":"C:/work/project","id":"review-readme","actor":"codex-sub-1"}
{"action":"submit","workspace":"C:/work/project","id":"review-readme","actor":"codex-sub-1",
 "summary":"Ran all 14 README commands; 13 passed, `npm run pack` failed with E404",
 "evidence":["terminal output: 13/14 exit 0","logs/pack-failure.txt lines 1-40"]}
```

Owner side:

```json
{"action":"verify","workspace":"C:/work/project","id":"review-readme","actor":"codex-main",
 "review":"Re-ran the failing command; reproduced E404, matches the submitted evidence"}
```

or send it back with a concrete reason:

```json
{"action":"reject","workspace":"C:/work/project","id":"review-readme","actor":"codex-main",
 "review":"Evidence lists no output for commands 7-9; re-run them and attach the results"}
```

Lifecycle: `assigned → accepted → started → submitted → verified`, with `rejected → accepted` for rework and `cancelled` from any non-terminal state.

`actor` is checked against the recorded owner or assignee; a mismatch returns `PERMISSION`. Identity is declared, not authenticated — this is a coordination record, not an access-control boundary. Do not advance a duty on someone else's behalf.

## Honesty rules

- `submit` requires a summary and at least one evidence string. Evidence means artifact paths, commands and real outcomes, never "tests passed" alone.
- `verify` records the owner's review and **does not run the acceptance criteria**. Run them yourself.
- A rejected duty is not a cancelled one: the assignee can accept it again after fixing the problem.

## 中文要点

交接需要 owner 与 assignee 两个声明身份且不能相同；`responsibilities`/`acceptance` 要写成可判断是否达成的条目；受派人 `accept → start → submit`（必须带 summary 与真实 evidence），只有 owner 能 `verify`/`reject`/`cancel`，`actor` 不匹配会被拒；`verify` 只是记录复核，验收条件要自己实际跑；不要提交伪造证据。
