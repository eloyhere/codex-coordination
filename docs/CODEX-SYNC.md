# Codex / AMP synchronization

## Project-owned persistence

Every actual project owns its `.codex-coordination/amp-07/store.sqlite`.
AMP native entities and Codex hook/goal observations use this same project-local
store. There is no global Codex synchronization database or shared project pool.
The selected workspace root must match the actual project; hooks use their `cwd`.
Existing directory/database links that escape that root are rejected.

A new `.codex-coordination/.gitignore` ignores generated persistence files.
Existing ignore rules and existing data are preserved. Already tracked files
remain tracked; creating this ignore file does not change Git history.

Cache creation also maintains project-level VCS exclusion rules, both for the
legacy ledger and native AMP store. Git/Git-backed Jujutsu use `.gitignore`;
detected Mercurial, Bazaar and Fossil projects receive `.hgignore`, `.bzrignore`
and `.fossil-settings/ignore-glob` rules respectively. Existing text/newlines
are preserved, repeat calls do not duplicate rules, and configuration links
outside the project are refused. Unknown adapters (including SVN properties)
are explicitly reported to stderr rather than assumed to honor Git rules.
Mercurial/Fossil/Bazaar configuration currently requires the selected project
to be the checkout root; parent repository settings are never silently edited.
VCS exclusion is separate from OS hidden attributes or editor file visibility.

Legacy runtime state also uses `.codex-coordination/amp-legacy/`: control.sqlite,
domain.sqlite and coordination.sqlite. The old home control database (or
CODEX_AMP_DATABASE override) is now a read-only migration source; `:memory:`
remains a nonpersistent test mode. Project-specific control scopes, revoked
historical sessions, preferences/registries and owned retrieval archives are
imported once. Old global defaults become an initial project-local snapshot.
Unscoped historical records whose ownership cannot be proven stay at source;
the migration report lists these categories. The source is never deleted.

Codex's own goal database is only an optional read-only upstream source. Its
contents are not the plugin's persistence location. Only the requested, observed
chat's goal is mirrored into the selected project's store.

## Synchronization contract and current limits

Agents call AMP on demand. Plugin hooks observe real Codex session/turn IDs,
user prompts, final assistant messages and tool calls/results automatically.
Goals can be pulled from Codex or pushed using the existing app-server control
connection. Push preflight compares the current goal digest; detected conflicts
return Codex's goal as the winner. The host API has no atomic goal CAS, so a
concurrent edit after preflight remains a limitation.

Hooks are not a complete assistant message stream. Intermediate assistant
messages still require an app-server event connection. Hook observations are
kept as observations; they do not manufacture native AMP execution, approval,
verification or business completion. Observed SessionStart creates/activates a
native AMP session; SessionEnd suspends it for recovery, and a later start uses
the native resumed-to-active path. Repeated starts do not duplicate transitions.
The sync status includes this native session. Native turn mapping still requires
an explicit input classification unavailable in current hooks. Goal writes require a working existing host
control connection. Installing the plugin does not bypass Codex hook trust.

The plugin UI is settings-only by current user preference. The status row,
session detail dialog and snackbar/popover/dialog/alert notification UI have
been removed. The notification compatibility tool has no UI metadata and
returns displayed:false without queuing or displaying anything. Backend
session data and business tools remain available independently of the UI.
