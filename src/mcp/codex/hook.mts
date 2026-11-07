/** Command-hook entrypoint: stdout is always a neutral Codex hook response. */
import { ingestHook, mirrorGoal } from './events.mjs'
import { getCodexGoal } from './goals.mjs'
import { prepareHookAttention } from './attention-lifecycle.mjs'

try {
  let bytes = 0; const chunks: Buffer[] = []
  for await (const part of process.stdin) { const buffer = Buffer.from(part); bytes += buffer.length; if (bytes > 8 * 1024 * 1024) throw new Error('Hook input exceeds 8 MiB'); chunks.push(buffer) }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  ingestHook(event)
  if (['SessionStart', 'UserPromptSubmit', 'Stop'].includes(event.hook_event_name)) {
    try { const result = await getCodexGoal(event.session_id); mirrorGoal(() => event.cwd, event.session_id, result.goal, result.source) } catch { /* Lifecycle capture remains available when goal access is unavailable. */ }
  }
  if (event.hook_event_name === 'SessionStart' || event.hook_event_name === 'UserPromptSubmit') {
    let attention = ''
    if (event.hook_event_name === 'UserPromptSubmit') {
      try { attention = prepareHookAttention(() => event.cwd, event.session_id, event.turn_id).text } catch { /* Context preview must not block Codex input. */ }
    }
    const guidance = `AMP tools are available on demand. Codex thread: ${event.session_id}${event.turn_id ? '; turn: ' + event.turn_id : ''}. Workspace: ${JSON.stringify(event.cwd)}. Select this workspace with coordination_workspace before workspace-scoped AMP calls. Use attention_manifest_protocol_discover for capabilities and attention_manifest_protocol_codex_sync with this threadId to inspect actual host observations. Lifecycle capture runs automatically. Never fabricate host events or treat Codex goal completion as independent AMP business verification.`
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: [guidance, attention].filter(Boolean).join('\n\n') } }) + '\n')
  }
  else process.stdout.write('{}\n')
} catch { process.stderr.write('AMP lifecycle capture failed; inspect the local bridge configuration.\n'); process.stdout.write('{}\n') }
