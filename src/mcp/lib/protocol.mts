import { Ajv2020 } from 'ajv/dist/2020.js'
import { fullFormats } from 'ajv-formats/dist/formats.js'
import type { LedgerSnapshot } from 'amp-legacy/ledger'
/** The bounded AMP surface supported by this Codex host adapter. */
import ampPackage from 'amp-legacy/package.json' with { type: 'json' }
import { artifactSchemas, artifactKinds } from '../amp/schemas.mjs'
import { validateClaim, validateHypothesis } from 'amp-legacy/warrant'
import { canonicalJson, digestOf, ERROR_CODES, fail, requireRecord, requireEnum } from './amp.mjs'
import { verifySnapshot as upstreamVerify } from 'amp-legacy/ledger'

export const PROTOCOL_INFO = { package: ampPackage.name, version: ampPackage.version }
export const SCHEMAS = artifactKinds
const schemas = artifactSchemas
export function schemaFor(kind: unknown) {
  const key = requireEnum(kind, Object.keys(SCHEMAS), 'kind')
  return loadSchema(SCHEMAS[key] + '.schema.json')
}
function loadSchema(name: string) {
  if (!Object.hasOwn(schemas, name)) throw new Error('unsupported schema reference: ' + name)
  return schemas[name]
}

const validator = new Ajv2020({ allErrors: true, formats: fullFormats })
for (const schema of Object.values(schemas)) validator.addSchema(schema)

export function validateArtifact(input: unknown) {
  canonicalJson(input)
  const artifact = requireRecord(input, 'artifact')
  const schema = schemaFor(artifact.kind)
  const validate = validator.getSchema(schema.$id)!
  const ok = validate(artifact)
  const problems = ok ? [] : (validate.errors ?? []).map(error => error.instancePath + ' ' + error.message)
  if (ok && artifact.kind === 'claim') problems.push(...validateClaim(artifact as any))
  if (ok && artifact.kind === 'hypothesis') problems.push(...validateHypothesis(artifact as any))
  if (artifact.kind === 'ledger-snapshot' && problems.length === 0) problems.push(...upstreamVerify(artifact as unknown as LedgerSnapshot).reasons)
  return { ok: problems.length === 0, problems, digest: digestOf(artifact) }
}

export function requireArtifact(artifact: unknown) {
  const verdict = validateArtifact(artifact)
  if (!verdict.ok) fail(ERROR_CODES.INVALID_ARGUMENT, 'artifact does not conform to AMP', { problems: verdict.problems })
  return verdict
}
