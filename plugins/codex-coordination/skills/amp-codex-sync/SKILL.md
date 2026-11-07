---
name: amp-codex-sync
description: Use AMP tools on demand and inspect or synchronize actual Codex lifecycle and thread goals through the installed local bridge.
---

Use the real thread/turn IDs from the trusted plugin hook context. Select its
workspace with coordination_workspace, then use attention_manifest_protocol_discover
to find AMP capabilities. attention_manifest_protocol_codex_sync status reads
recorded host observations; pull_goal refreshes the actual persisted Codex goal.
Never manufacture a host event or substitute an import session for a Codex chat.

Goal policy is bidirectional with Codex priority. For a supported outbound update,
read pull_goal first and pass its expectedDigest to push_goal. Changed native
objective/status/budget wins a conflict. Writes use origin automatic; never
forge user provenance or write Codex SQLite files. Native set has no atomic CAS,
so the bridge reports this limitation instead of promising race-free resolution.
If the control socket is unavailable, writes fail rather than modify the database.

Command hooks capture user/final assistant messages, lifecycle and tool results
for enabled local chats after the user trusts the hook definitions. They do not
provide the complete intermediate assistant message stream. A real app-server
event connection is still required for full streaming. Goal reads can fall back
to a read-only, schema-checked local goal database. Treat these capability gaps
as incomplete integration, not successful full synchronization.

Host observations persist in the actual project's .codex-coordination directory,
alongside native AMP data. The generated local state directory is git-ignored. Keep
the plugin UI settings-only; notification surfaces and session dialogs are disabled by user request. Never infer AMP business verification
from a Codex goal status or a tool's execution success.
