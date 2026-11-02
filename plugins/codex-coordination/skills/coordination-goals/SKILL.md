---
name: coordination-goals
description: Create, inspect and advance coordination goals that have observable success criteria. 用可观察的成功条件创建并推进协调目标。
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

Rules worth knowing before the server tells you:

- `id` matches `^[a-z][a-z0-9._:-]{0,63}$`.
- At least one success criterion; each needs a `check` that somebody can actually perform. "It works" is not a check.
- `value` is in `[0, 1]`; `priority` is a nonnegative integer.
- Optional `horizon` is `task`, `session` or `long`; optional `deadline` is an RFC 3339 timestamp with a timezone.

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

## 中文要点

目标要写清可观察的成功条件与检查方法；先 `list` 复用已有目标，避免重复；生命周期只能沿 `proposed → committed → active → achieved/abandoned` 前进；标记 `achieved` 只是记录你的断言，必须先实际执行每条成功检查，不合格就保持 `active` 或说明原因后 `abandon`。
