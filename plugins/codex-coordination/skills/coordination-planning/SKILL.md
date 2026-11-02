---
name: coordination-planning
description: Turn a goal into a bounded, dependency-checked plan and move its tasks honestly. 把目标拆成有界、可校验依赖关系的计划并如实推进任务。
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
    "commitmentWindow": 3,
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

- At most **12** tasks. A larger plan is not a plan, it is a backlog; split it.
- Dependencies are declared on the task (`pre`) and the edge list is derived. Cycles are rejected.
- `expect.check` is mandatory — a task whose result cannot be checked is not a task.
- `irreversibility` is `0-3`: 0 trivially reversible, 3 destructive. Use it to decide what needs a confirmation before running.
- `goal` is optional, but when present it must already exist.

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

Close the plan only when every task is terminal (`done`, `failed` or `skipped`):

```json
{"action":"transition","workspace":"C:/work/project","id":"export-plan","status":"done"}
```

Then, and only then, consider the goal's `achieved` transition — after running its own success checks.

Marking a task `done` records that you say it is done. Run the task's check first, and put the observed result in `note` when it is not obvious from the record.

## 中文要点

计划最多 12 个任务，依赖写在任务的 `pre` 上（自动成边、自动查环），每个任务必须有可执行的 `expect.check`；新计划是 `draft`，先 `committed` 才能动任务；任务进入 `running`/`done` 前所有前置必须为 `done`；所有任务终态后才能把计划置 `done`；`done` 只是记录，必须真的执行过检查。
