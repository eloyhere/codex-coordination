/** Codex observations share the actual project's durable AMP store. */
import { openNativeStore } from '../amp/native-store.mjs'

export function openCodexStore(root: string) {
  return openNativeStore(() => root).store
}
