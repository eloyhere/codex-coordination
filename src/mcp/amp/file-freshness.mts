/** Validate the exact raw bytes cited by native file-read receipts. */
import { NativeReadStorage } from './filesystem.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'
import type { ReceiptCore } from 'attention-manifest-protocol/receipt'
import { realpathSync } from 'node:fs'

export const fileReceiptTools = new Set(['attention_manifest_protocol_workspace.read', 'attention_manifest_protocol_workspace.outline', 'attention_manifest_protocol_workspace.document_outline', 'attention_manifest_protocol_workspace.write', 'attention_manifest_protocol_replace'])

export function assertFileFreshness(receipt: ReceiptCore, root: string, tenantId: string, policy?: () => NativeFilesystemScope | undefined): void {
  if (!fileReceiptTools.has(receipt.invocation.toolId)) return
  const anchor = receipt.workspaceAnchor
  const path = (receipt.invocation.arguments as any)?.path
  if (typeof path !== 'string' || !anchor?.snapshotId || anchor.affectedFiles?.length !== 1 || anchor.affectedFiles[0] !== path) throw new Error('File receipt has no complete raw-byte freshness anchor')
  const provided = policy?.()
  if (provided && realpathSync(provided.root) !== realpathSync(root)) throw new Error('File receipt policy workspace changed')
  try {
    const storage = new NativeReadStorage(provided ?? { root, exclude: [] }, tenantId)
    if (storage.raw(path).hash !== anchor.snapshotId) throw new Error('changed')
  } catch { throw new Error('Receipt file is missing, excluded or changed; execute again before verification or citation') }
}
