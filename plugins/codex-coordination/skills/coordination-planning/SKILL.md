---
name: coordination-planning
description: Turn a goal into a bounded AMP plan and move its tasks honestly. 把目标拆成有界 AMP 计划并如实推进任务。
---

# Coordination planning

Use this skill when a goal needs more than one step and the order matters. The plan is the durable record of *how* the outcome will be reached; the goal stays the record of *what*.

Every call takes `workspace`: the absolute repository root.

## Create a draft

```json
{
  "action": "create",
  "workspace": "C:/work/project",
  "plan": {
    "amp": "0.1",
    "kind": "plan",
    "id": "export-plan",
    "goal": {"kind": "goal", "id": "deterministic-export"},
    "commitment_window": 3,
    "budget": {"ms": 600000},
    "abandon_if": [
      {
        "id": "no-value",
        "statement": "The export path needs a network clock after all",
        "check": "Read the writer's clock source"
      }
    ],
    "tasks": [
      {
        "id": "pin-clock",
        "intent": "Replace wall-clock timestamps in the writer with a fixed epoch",
        "actor": "self",
        "expect": {
          "observation": "No Date.now() call remains on the export path",
          "check": "grep the export module and run the export test"
        },
        "irreversibility": 1
      },
      {
        "id": "compare-digests",
        "intent": "Compare two exports of the same fixture",
        "actor": "tool",
        "pre": ["pin-clock"],
        "expect": {
          "observation": "Both files hash to the same digest",
          "check": "sha256sum both outputs and compare"
        }
      }
    ]
  }
}
```

- `goal` and `abandon_if` are **required**, because AMP requires them: a plan serves a goal, and a plan with no condition that would make it stop has no commitment. The goal must already exist.
- Use AMP spellings: `commitment_window`, `abandon_if`. The camelCase forms are rejected with the field to use instead; guessing which spelling won would make the record depend on the caller's habit.
- `edges`, `status` and `created` are computed by the server and rejected as input.
- At most **12** tasks. A larger plan is not a plan, it is a backlog; split it.
- Dependencies are declared on the task (`pre`) and the edge list is derived. Cycles are rejected.
- `expect.check` is mandatory — a task whose result cannot be checked is not a task.
- `irreversibility` is `0-3`: 0 trivially reversible, 3 destructive. Use it to decide what needs a confirmation before running.
- `commitment_window` is `1-5` (default 3) and `budget` is an AMP budget object (default `{}`).

The result carries `plan` (the strict AMP artifact), `progress` (ready and blocked tasks) and `history`.

## Commit, then execute

```json
{"action":"transition","workspace":"C:/work/project","id":"export-plan","status":"committed"}
```

A fresh plan is a `draft`; tasks cannot move until it is committed — committing is the moment the graph is declared worth executing.

```json
{"action":"task","workspace":"C:/work/project","id":"export-plan","task":{"id":"pin-clock","status":"running"}}
{"action":"task","workspace":"C:/work/project","id":"export-plan","task":{"id":"pin-clock","status":"done","note":"writer now uses SOURCE_DATE_EPOCH"}}
```

Rules the server enforces:

- A task may enter `running` or `done` only when every predecessor is `done`; otherwise it reports `blockedBy`.
- Task edges: `pending -> running|done|skipped`, `running -> done|failed|skipped`, `failed -> running|skipped`.
- Starting the first task of a committed plan promotes the plan to `executing` automatically.

Every plan mutation appends the updated Plan artifact as one `plan` chain entry, because the artifact itself changed (status, task status). Free-form notes live in the returned `history`; the artifact has no field for commentary.

Close the plan only when every task is terminal (`done`, `failed` or `skipped`):

```json
{"action":"transition","workspace":"C:/work/project","id":"export-plan","status":"done"}
```

Then, and only then, consider the goal's `achieved` transition — after running its own success checks.

Marking a task `done` records that you say it is done. Run the task's check first, and put the observed result in `note` when it is not obvious from the record.

## 中文要点

计划是严格的 AMP `Plan`：`goal` 与 `abandon_if` 必填，`edges`/`status`/`created` 由服务端计算、不接受输入；字段名用 AMP 拼写 `commitment_window`/`abandon_if`，驼峰写法会被拒绝并提示正确字段。最多 12 个任务，依赖写在任务的 `pre` 上（自动成边、自动查环），每个任务必须有可执行的 `expect.check`。新计划是 `draft`，先 `committed` 才能动任务；任务进入 `running`/`done` 前所有前置必须为 `done`；所有任务终态后才能把计划置 `done`。每次变更都会把更新后的 Plan 产物追加进链；`done` 只是记录，必须真的执行过检查。
