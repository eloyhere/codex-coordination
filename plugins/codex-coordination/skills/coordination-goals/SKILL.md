---
name: coordination-goals
description: Create, inspect and advance AMP goals that have observable success criteria. 用可观察的成功条件创建并推进 AMP 目标。
---

# Coordination goals

Use this skill when the user asks for an outcome that outlives one reply — "finish the migration", "make the export deterministic", "get CI green" — and the work needs to be resumed by a later session, or handed to another one.

Every call takes `workspace`: the **absolute** path of the repository root you are working in (your session's working directory). The server does not guess it; a relative path is rejected.

## Start by reading

```json
{"action":"list","workspace":"C:/work/project"}
```

Reuse an existing goal if it names the same outcome. Creating a near-duplicate goal splits the record and makes "what is left" unanswerable.

## Create one

```json
{
  "action": "create",
  "workspace": "C:/work/project",
  "goal": {
    "amp": "0.1",
    "kind": "goal",
    "id": "deterministic-export",
    "statement": "Exported workbooks contain identical bytes for identical inputs",
    "success": [
      {
        "id": "same-bytes",
        "statement": "Two exports of the same input are byte-identical",
        "check": "Run the export twice into separate files and compare SHA-256 digests"
      }
    ],
    "value": 0.8,
    "priority": 2,
    "horizon": "task"
  }
}
```

What the server enforces, before it tells you:

- The accepted fields are exactly the AMP Goal schema's: `amp`, `kind`, `id`, `statement`, `success`, `value`, `priority`, `horizon`, `deadline`. An unknown field is an `INVALID_ARGUMENT` naming the field — a misspelling is never silently dropped.
- `id` matches `^[a-z][a-z0-9._:-]{0,63}$`.
- At least one success criterion; each needs a `check` that somebody can actually perform. "It works" is not a check.
- `value` is in `[0, 1]`; `priority` is a nonnegative integer; optional `horizon` is `task`, `session` or `long`; optional `deadline` is an RFC 3339 timestamp with a timezone.

The result separates the protocol from the host: `goal` is the strict AMP artifact (validates against `plan.schema.json`), and `lifecycle` is AMP's `GoalLifecycle` (`state`, `startedAt`, `achievedAt`) beside `createdAt`, `updatedAt` and `history`. Do not paraphrase the artifact back as a different shape.

## Advance it

```json
{"action":"transition","workspace":"C:/work/project","id":"deterministic-export","state":"committed","note":"agreed with the user"}
```

The only legal edges are:

```
proposed -> committed | abandoned
committed -> active | abandoned
active -> achieved | abandoned
achieved, abandoned -> (terminal)
```

Creating returns `proposed`. Commit when someone accepts the goal, then move to `active` when work starts.

`achieved` additionally requires every plan linked to the goal to be `done` or `abandoned`. Run each success check first and record what you observed; the transition records your assertion — it does not run anything for you. If a check fails, leave the goal `active` and say so, or `abandon` it with a note. Never claim `achieved` on unverified work.

The ledger chain sees the difference: creating a goal appends a `goal` entry carrying the artifact, while a transition appends an `event` entry (`{"type":"goal.transitioned","goal":…,"from":…,"to":…}`) because the artifact itself does not change.

## 中文要点

目标对象就是 AMP 的 `Goal`：只接受 schema 里的字段，写错字段名会直接报错而不是被丢掉；`id` 要匹配 `^[a-z][a-z0-9._:-]{0,63}$`；至少一条成功条件且每条都要有可执行的 `check`；`value ∈ [0,1]`、`priority` 为非负整数。返回结果里 `goal` 是严格 AMP 产物，`lifecycle` 是生命周期（`state`/`startedAt`/`achievedAt`）。生命周期只能沿 `proposed → committed → active → achieved/abandoned` 前进；标记 `achieved` 只是记录断言，必须先实际执行每条成功检查，不合格就保持 `active` 或说明原因后 `abandon`。
