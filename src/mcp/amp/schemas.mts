// Generated from the published AMP schemas by scripts/inventory-amp.mjs.
import s0 from 'amp-legacy/schemas/collaboration.schema.json' with { type: 'json' }
import s1 from 'amp-legacy/schemas/common.schema.json' with { type: 'json' }
import s2 from 'amp-legacy/schemas/compaction.schema.json' with { type: 'json' }
import s3 from 'amp-legacy/schemas/concept-compaction.schema.json' with { type: 'json' }
import s4 from 'amp-legacy/schemas/concept.schema.json' with { type: 'json' }
import s5 from 'amp-legacy/schemas/epistemic.schema.json' with { type: 'json' }
import s6 from 'amp-legacy/schemas/federation.schema.json' with { type: 'json' }
import s7 from 'amp-legacy/schemas/frame.schema.json' with { type: 'json' }
import s8 from 'amp-legacy/schemas/ledger-snapshot.schema.json' with { type: 'json' }
import s9 from 'amp-legacy/schemas/manifest.schema.json' with { type: 'json' }
import s10 from 'amp-legacy/schemas/message.schema.json' with { type: 'json' }
import s11 from 'amp-legacy/schemas/plan.schema.json' with { type: 'json' }
import s12 from 'amp-legacy/schemas/receipt.schema.json' with { type: 'json' }
import s13 from 'amp-legacy/schemas/social.schema.json' with { type: 'json' }
import s14 from 'amp-legacy/schemas/team.schema.json' with { type: 'json' }
import s15 from 'amp-legacy/schemas/verb.schema.json' with { type: 'json' }
export const artifactSchemas: Record<string, any> = {
  'collaboration.schema.json': s0,
  'common.schema.json': s1,
  'compaction.schema.json': s2,
  'concept-compaction.schema.json': s3,
  'concept.schema.json': s4,
  'epistemic.schema.json': s5,
  'federation.schema.json': s6,
  'frame.schema.json': s7,
  'ledger-snapshot.schema.json': s8,
  'manifest.schema.json': s9,
  'message.schema.json': s10,
  'plan.schema.json': s11,
  'receipt.schema.json': s12,
  'social.schema.json': s13,
  'team.schema.json': s14,
  'verb.schema.json': s15,
}
export const artifactKinds: Readonly<Record<string, string>> = Object.freeze({"delegation":"collaboration","lease":"collaboration","result-contract":"collaboration","checkpoint":"compaction","prune-plan":"compaction","concept-prune-plan":"concept-compaction","concept-checkpoint":"concept-compaction","concept":"concept","claim":"epistemic","hypothesis":"epistemic","unknown":"epistemic","bundle":"federation","attestation":"federation","frame":"frame","ledger-snapshot":"ledger-snapshot","manifest":"manifest","message":"message","goal":"plan","process":"plan","plan":"plan","receipt":"receipt","event":"receipt","other-model":"social","common-ground":"social","attention-request":"social","team-manifest":"team","commitment-record":"team","call":"verb"})
