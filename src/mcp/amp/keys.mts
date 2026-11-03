/** Host-owned Ed25519 keys; all signing and verification use AMP implementations. */
import { manifest, governance, protocol, ledger } from './runtime.mjs'
import type { Database } from 'attention-manifest-protocol/database'
import type { KeyPair } from 'attention-manifest-protocol/manifest'
import { ERROR_CODES, fail } from '../lib/amp.mjs'

const operations: Record<string, Record<string, Function>> = {
  manifest: Object.fromEntries(['signManifest', 'verifyManifest', 'verifyWithRegistry', 'signCard', 'verifyCardSignature', 'verifyCardWithRegistry', 'exportBundle', 'importBundle', 'attest', 'verifyAttestation', 'verifyAttestationWithKey', 'trustCard'].map(name => [name, (manifest as any)[name]])),
  governance: Object.fromEntries(['signCanonicalValue', 'verifyCanonicalValue', 'signGovernanceDigest', 'verifyGovernanceSignature', 'signGovernanceObject', 'verifyGovernanceBundle'].map(name => [name, (governance as any)[name]])),
  protocol: { sealEnvelope: protocol.sealEnvelope, verifyEnvelope: protocol.verifyEnvelope },
  ledger: { sealCheckpoint: ledger.sealCheckpoint, verifyCheckpoint: ledger.verifyCheckpoint, verifySnapshotAgainstCheckpoint: ledger.verifySnapshotAgainstCheckpoint },
}
interface StoredKey { kid: string; public_jwk: string; private_jwk: string | null; status: string; valid_from: string; valid_to: string | null; signer: string; revoked_at?: string | null; supersedes?: string | null; note?: string | null }
export class HostKeys {
  private governanceKeyrings = new Set<{ current: InstanceType<typeof governance.GovernanceKeyring>; blocked: boolean }>()
  constructor(private readonly database: Database) {
    database.db.exec('CREATE TABLE IF NOT EXISTS codex_amp_keys(kid TEXT PRIMARY KEY,public_jwk TEXT NOT NULL,private_jwk TEXT,status TEXT NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT,signer TEXT NOT NULL)')
    const columns = database.db.prepare('PRAGMA table_info(codex_amp_keys)').all() as { name: string }[]
    for (const column of ['revoked_at', 'supersedes', 'note']) if (!columns.some(item => item.name === column)) database.db.exec(`ALTER TABLE codex_amp_keys ADD COLUMN ${column} TEXT`)
  }
  private rows() { return this.database.db.prepare('SELECT * FROM codex_amp_keys ORDER BY kid').all() as unknown as StoredKey[] }
  private row(kid: string) {
    const row = this.database.db.prepare('SELECT * FROM codex_amp_keys WHERE kid=?').get(kid) as unknown as StoredKey | undefined
    if (!row) fail(ERROR_CODES.NOT_FOUND, 'Unknown host key')
    return row
  }
  private async publicKey(row: StoredKey) { return crypto.subtle.importKey('jwk', JSON.parse(row.public_jwk), 'Ed25519', true, ['verify']) }
  async verificationKey(kid: string, historical = false) {
    const row = this.row(kid)
    if (!historical) {
      const keyring = await this.decode({ $keyring: true }) as InstanceType<typeof manifest.Keyring>
      if (!keyring.verifyWindow(kid, new Date().toISOString()).ok) fail(ERROR_CODES.INVALID_STATE, 'Host key is outside its verification lifecycle')
    }
    return this.publicKey(row)
  }
  async pair(kid: string): Promise<KeyPair> {
    const row = this.row(kid)
    const keyring = await this.decode({ $keyring: true }) as InstanceType<typeof manifest.Keyring>
    if (row.status !== 'active' || !row.private_jwk || !keyring.verifyWindow(kid, new Date().toISOString()).ok) fail(ERROR_CODES.INVALID_STATE, 'Key is unavailable for signing')
    return { kid, publicKey: await this.publicKey(row), privateKey: await crypto.subtle.importKey('jwk', JSON.parse(row.private_jwk), 'Ed25519', true, ['sign']) }
  }
  private async refreshKeyrings() {
    for (const holder of this.governanceKeyrings) holder.blocked = true
    for (const holder of this.governanceKeyrings) { holder.current = await this.decode({ $governanceKeyring: true }); holder.blocked = false }
  }
  async decode(value: any, live = false): Promise<any> {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return Promise.all(value.map(item => this.decode(item)))
    if (Object.keys(value).length === 1) {
      if ('$key' in value) return this.pair(value.$key)
      if ('$publicKey' in value) return this.publicKey(this.row(value.$publicKey))
      if ('$signer' in value) { const pair = await this.pair(value.$signer.kid); return { signer: value.$signer.signer ?? this.row(pair.kid).signer, key: pair } }
      if ('$keyRegistry' in value) {
        const registry = new manifest.KeyRegistry()
        for (const row of this.rows()) { registry.add(row.kid, await this.publicKey(row)); if (row.status === 'revoked') registry.revoke(row.kid) }
        return registry
      }
      if ('$keyring' in value) {
        const keyring = new manifest.Keyring()
        for (const row of this.rows()) { keyring.add({ kid: row.kid, publicKey: await this.publicKey(row), status: row.status === 'revoked' ? 'active' : row.status as any, validFrom: row.valid_from, ...(row.valid_to ? { validTo: row.valid_to } : {}), ...(row.supersedes ? { supersedes: row.supersedes } : {}), ...(row.note ? { note: row.note } : {}) }); if (row.status === 'revoked') keyring.revoke(row.kid, row.revoked_at ?? row.valid_from, row.note ?? undefined) }
        return keyring
      }
      if ('$governanceKeyring' in value) {
        const keyring = new governance.GovernanceKeyring()
        for (const row of this.rows()) { keyring.add(row.signer, await this.publicKey(row), { kid: row.kid, at: Date.parse(row.valid_from), ...(row.valid_to ? { retiresAt: Date.parse(row.valid_to) } : {}) }); if (row.status === 'revoked') keyring.revokeKid(row.signer, row.kid) }
        if (!live) return keyring
        const holder = { current: keyring, blocked: false }
        this.governanceKeyrings.add(holder)
        return new Proxy(keyring, { get: (_target, property) => {
          if (holder.blocked && property === 'candidates') return () => []
          if (holder.blocked && property === 'get') return () => undefined
          const value = (holder.current as any)[property]
          return typeof value === 'function' ? value.bind(holder.current) : value
        } })
      }
    }
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await this.decode(item)])))
  }
  async call(args: Record<string, any>) {
    if (args.action === 'describe') return { ok: true, modules: Object.fromEntries(Object.entries(operations).map(([module, funcs]) => [module, Object.keys(funcs)])), references: ['$key', '$publicKey', '$signer', '$keyRegistry', '$keyring', '$governanceKeyring'] }
    if (args.action === 'list') return { ok: true, keys: this.rows().map(row => ({ kid: row.kid, signer: row.signer, status: row.status, validFrom: row.valid_from, validTo: row.valid_to, publicJwk: JSON.parse(row.public_jwk), canSign: row.private_jwk !== null })) }
    if (args.action === 'keyring') {
      const keyring = await this.decode({ $keyring: true }) as InstanceType<typeof manifest.Keyring>
      if (args.method === 'verifyWindow') return { ok: true, result: keyring.verifyWindow(args.kid, args.at ?? new Date().toISOString()) }
      if (args.method === 'revocations') return { ok: true, result: keyring.revocations() }
      if (args.method === 'isRevoked') return { ok: true, result: keyring.isRevoked(args.kid) }
      fail(ERROR_CODES.INVALID_ARGUMENT, 'Use verifyWindow, revocations or isRevoked on the host keyring')
    }
    if (args.action === 'generate' || args.action === 'rotate' || args.action === 'import_public') {
      if (typeof args.kid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args.kid)) fail(ERROR_CODES.INVALID_ARGUMENT, 'A valid key ID is required')
      const pair = args.action === 'import_public' ? undefined : await manifest.generateSigningKey(args.kid)
      const publicJwk = pair ? await crypto.subtle.exportKey('jwk', pair.publicKey) : args.publicJwk
      if (publicJwk?.d !== undefined) fail(ERROR_CODES.INVALID_ARGUMENT, 'import_public accepts public keys only')
      await crypto.subtle.importKey('jwk', publicJwk, 'Ed25519', true, ['verify'])
      const privateJwk = pair ? await crypto.subtle.exportKey('jwk', pair.privateKey) : null
      const at = new Date().toISOString()
      const keyring = await this.decode({ $keyring: true }) as InstanceType<typeof manifest.Keyring>
      const publicKey = await crypto.subtle.importKey('jwk', publicJwk, 'Ed25519', true, ['verify'])
      let previous: ReturnType<typeof keyring.record>
      if (args.action === 'rotate') { if (args.validTo !== undefined) fail(ERROR_CODES.INVALID_ARGUMENT, 'Native KeyRotation does not accept validTo'); keyring.rotate(args.previousKid, { kid: args.kid, publicKey, overlapMs: args.overlapMs, validFrom: args.validFrom }); previous = keyring.record(args.previousKid) }
      else keyring.add({ kid: args.kid, publicKey, status: 'active', validFrom: args.validFrom ?? at, ...(args.validTo ? { validTo: args.validTo } : {}) })
      const record = keyring.record(args.kid)!
      this.database.transaction(() => {
        if (previous) this.database.db.prepare('UPDATE codex_amp_keys SET status=?,valid_to=? WHERE kid=?').run(previous.status, previous.validTo ?? null, previous.kid)
        this.database.db.prepare('INSERT INTO codex_amp_keys(kid,public_jwk,private_jwk,status,valid_from,valid_to,signer,supersedes) VALUES(?,?,?,?,?,?,?,?)').run(args.kid, JSON.stringify(publicJwk), privateJwk ? JSON.stringify(privateJwk) : null, record.status, record.validFrom, record.validTo ?? null, args.signer ?? (previous ? this.row(previous.kid).signer : args.kid), record.supersedes ?? null)
        this.database.objectService.put('key-lifecycle', crypto.randomUUID(), { action: args.action, kid: args.kid, publicJwk, status: record.status, validFrom: record.validFrom, validTo: record.validTo ?? null, supersedes: record.supersedes ?? null }, at)
      })
      await this.refreshKeyrings()
      return { ok: true, kid: args.kid, publicJwk }
    }
    if (args.action === 'revoke' || args.action === 'retire') {
      const keyring = await this.decode({ $keyring: true }) as InstanceType<typeof manifest.Keyring>
      const at = new Date().toISOString()
      const changed = args.action === 'revoke' ? keyring.revoke(args.kid, at, args.reason) : keyring.retire(args.kid, at)
      const record = keyring.record(args.kid)
      if (changed && record) this.database.transaction(() => {
        this.database.db.prepare('UPDATE codex_amp_keys SET status=?,valid_to=?,revoked_at=?,note=? WHERE kid=?').run(record.status, record.validTo ?? null, args.action === 'revoke' ? at : null, args.reason ?? null, args.kid)
        this.database.objectService.put('key-lifecycle', crypto.randomUUID(), { action: args.action, kid: args.kid, status: record.status, at, reason: args.reason ?? null }, at)
      })
      if (changed) await this.refreshKeyrings()
      return { ok: true, kid: args.kid, changed }
    }
    const operation = Object.hasOwn(operations, args.module) && Object.hasOwn(operations[args.module], args.operation) ? operations[args.module][args.operation] : undefined
    if (args.action !== 'call' || !operation || !Array.isArray(args.arguments)) fail(ERROR_CODES.INVALID_ARGUMENT, 'Select a published signing or verification operation')
    const result = await Reflect.apply(operation, undefined, await this.decode(args.arguments))
    this.database.objectService.put('crypto-operation', crypto.randomUUID(), { module: args.module, operation: args.operation, at: new Date().toISOString() }, new Date().toISOString())
    return { ok: true, result }
  }
}
