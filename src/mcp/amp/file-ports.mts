/** Filesystem-only AMP helpers receive authorized paths or a bounded staged tree. */
import { mkdtempSync, mkdirSync, readdirSync, lstatSync, copyFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { file, fingerprint, outline, registry } from './runtime.mjs'
import type { FilesystemSession } from 'attention-manifest-protocol/file'
import type { Database } from 'attention-manifest-protocol/database'
import { ERROR_CODES, fail } from '../lib/amp.mjs'

export const FileOperations = ['fingerprintFile', 'fingerprintFileMeta', 'fingerprintTree', 'parseOffice', 'collectDirectory', 'digestDirectory', 'diffDirectory', 'verifyModuleContent'] as const
export class HostFilePorts {
  private sandbox: InstanceType<typeof file.PathSandbox>
  constructor(session: FilesystemSession, private readonly database: Database) { this.sandbox = new file.PathSandbox(session.descriptor.roots) }
  private async staged(path: string, run: (directory: string) => Promise<unknown>) {
    const root = this.sandbox.resolve(path, 'read')
    const temporaryRoot = realpathSync(tmpdir())
    const stage = mkdtempSync(join(temporaryRoot, 'amp-native-directory-'))
    let count = 0, bytes = 0
    const walk = (relative: string, target: string) => {
      const absolute = this.sandbox.resolve(relative, 'list').absolute
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const child = relative === '.' ? entry.name : `${relative}/${entry.name}`
        if (entry.isSymbolicLink() || this.sandbox.isExcluded(root.root, child)) continue
        const item = this.sandbox.resolve(child, 'read')
        const destination = join(target, entry.name)
        if (entry.isDirectory()) { mkdirSync(destination); walk(child, destination) }
        else if (entry.isFile()) {
          bytes += lstatSync(item.absolute).size; count++
          if (bytes > 32 * 1024 * 1024 || count > 10000) fail(ERROR_CODES.INVALID_ARGUMENT, 'Directory exceeds host staging limits (32 MiB / 10000 files); choose a smaller subtree')
          copyFileSync(item.absolute, destination)
        }
      }
    }
    try { walk(root.relative, stage); return await run(stage) }
    finally {
      if (dirname(resolve(stage)) !== resolve(temporaryRoot) || !stage.startsWith(join(temporaryRoot, 'amp-native-directory-'))) throw new Error('Invalid owned staging directory')
      rmSync(stage, { recursive: true, force: true })
    }
  }
  async call(args: Record<string, any>) {
    const operation = args.operation
    if (!FileOperations.includes(operation)) fail(ERROR_CODES.INVALID_ARGUMENT, 'Unknown AMP file operation')
    if (operation === 'verifyModuleContent') return registry.verifyModuleContent(this.database.db, entry => this.staged(entry, directory => registry.digestDirectory(directory)) as Promise<string>)
    const path = typeof args.path === 'string' ? args.path : '.'
    const target = this.sandbox.resolve(path, 'read')
    if (operation === 'fingerprintFile') return fingerprint.fingerprintFile(target.absolute, args.options)
    if (operation === 'fingerprintFileMeta') return fingerprint.fingerprintFileMeta(target.absolute)
    if (operation === 'parseOffice') return outline.parseOffice(this.sandbox, path)
    if (operation === 'fingerprintTree') return this.staged(path, directory => fingerprint.fingerprintTree(directory, args.options))
    return this.staged(path, directory => operation === 'collectDirectory' ? registry.collectDirectory(directory) : operation === 'digestDirectory' ? registry.digestDirectory(directory) : registry.diffDirectory(directory, args.expected ?? []))
  }
}
