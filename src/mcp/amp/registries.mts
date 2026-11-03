/** JSON adapters around AMP registry methods; executable callbacks remain host bindings. */
import * as amp from './runtime.mjs'
import type { Database } from 'attention-manifest-protocol/database/service'
import { canonicalJson, ERROR_CODES, fail } from '../lib/amp.mjs'
import { AMP_DEFINITIONS } from './host.mjs'
import type { HostComponent } from 'attention-manifest-protocol/discover'

export const RegistryNames = ['skills', 'knowledge', 'protocols', 'modules', 'environments', 'concepts', 'tools', 'outlines', 'outlineKeywords', 'languages', 'tokenKinds', 'nodeKinds', 'sqlDialects', 'calibrations', 'behaviors', 'entities'] as const
type Specialized = Exclude<typeof RegistryNames[number], 'skills' | 'knowledge' | 'protocols' | 'modules' | 'environments' | 'concepts'>
type Operation = { action: 'register' | 'update' | 'remove' | 'clear'; id?: string; value?: Record<string, any> }
const categories = ['variable', 'function', 'type', 'import', 'modifier', 'control', 'literal'] as const
const defaults = {
  languages: amp.syntax.DefaultSyntaxRegistry.languages(), tokens: amp.syntax.DefaultSyntaxRegistry.tokenKindsList(), nodes: amp.syntax.DefaultSyntaxRegistry.nodeKindsList(),
  outlines: [...amp.outline.DefaultOutlineRegistry.list()], sql: [...amp.sqlOutline.DefaultSqlDialectRegistry.list()],
  keywords: categories.flatMap(category => amp.outline.DefaultOutlineKeywords.words(category).map(word => ({ word, category }))),
}

/** Each operation is replayed against fresh upstream instances before persistence. */
function instances() {
  const syntax = new amp.syntax.SyntaxRegistry()
  defaults.languages.forEach(value => syntax.registerLanguage(value))
  defaults.tokens.forEach(value => syntax.registerTokenKind(value))
  defaults.nodes.forEach(value => syntax.registerNodeKind(value))
  const keywords = new amp.outline.OutlineKeywordRegistry()
  defaults.keywords.forEach(value => keywords.register(value.category, value.word))
  return { syntax, keywords, outlines: new amp.outline.OutlineRegistry(defaults.outlines), sql: new amp.sqlOutline.SqlDialectRegistry(defaults.sql),
    calibrations: new amp.bayes.CalibrationRegistry(), behaviors: new amp.runtime.BehaviorRegistry(), entities: new amp.entityMetadata.EntityRegistry(), tools: new amp.moduleApi.ToolRegistry(), targets: new Map<string, string>() }
}
type Instances = ReturnType<typeof instances>
function list(state: Instances, name: Specialized): Record<string, any>[] {
  switch (name) {
    case 'languages': return state.syntax.languages()
    case 'tokenKinds': return state.syntax.tokenKindsList()
    case 'nodeKinds': return state.syntax.nodeKindsList()
    case 'outlineKeywords': return categories.flatMap(category => state.keywords.words(category).map(word => ({ id: word, category })))
    case 'outlines': return state.outlines.list().map(({ id, category, language }) => ({ id, category, ...(language ? { language } : {}) }))
    case 'sqlDialects': return state.sql.list().map(value => ({ ...value, id: value.dialect }))
    case 'calibrations': return state.calibrations.scopes().map(scope => ({ ...state.calibrations.model(scope), id: scope }))
    case 'behaviors': return state.behaviors.list()
    case 'entities': return state.entities.names().map(id => ({ ...state.entities.get(id), id }))
    case 'tools': return state.tools.list().map(value => ({ ...value, id: value.name, target: state.targets.get(value.name) }))
  }
}
function mutate(state: Instances, name: Specialized, operation: Operation) {
  const { action, id, value = {} } = operation
  const method = action === 'register' ? 'register' : 'update'
  if (action === 'clear') {
    for (const entry of list(state, name)) mutate(state, name, { action: 'remove', id: entry.id })
    return
  }
  if (name === 'languages' || name === 'tokenKinds' || name === 'nodeKinds') {
    if (action === 'remove') { if (name === 'languages') state.syntax.removeLanguage(id!); else if (name === 'tokenKinds') state.syntax.removeTokenKind(id!); else state.syntax.removeNodeKind(id!); return }
    if (name === 'languages') state.syntax[method === 'register' ? 'registerLanguage' : 'updateLanguage']({ ...value, id } as any)
    else if (name === 'tokenKinds') state.syntax[method === 'register' ? 'registerTokenKind' : 'updateTokenKind']({ ...value, id } as any)
    else state.syntax[method === 'register' ? 'registerNodeKind' : 'updateNodeKind']({ ...value, id } as any)
  } else if (name === 'outlineKeywords') {
    if (action === 'remove') state.keywords.remove(id!)
    else state.keywords[method](value.category, id!)
  } else if (name === 'outlines') {
    if (action === 'remove') { state.outlines.remove(id!); return }
    const template = defaults.outlines.find(item => item.id === (value.template ?? id))
    if (!template) throw new Error('Outline parsers must reference an installed AMP strategy template')
    const extensions = value.extensions
    if (extensions !== undefined && (!Array.isArray(extensions) || extensions.some(item => typeof item !== 'string' || !item.startsWith('.')))) throw new Error('extensions must be file suffixes')
    state.outlines[method]({ ...template, id: id!, ...(value.category ? { category: value.category } : {}), ...(value.language ? { language: value.language } : {}), ...(extensions ? { matches: input => extensions.some((suffix: string) => input.name.endsWith(suffix)) } : {}) })
  } else if (name === 'sqlDialects') {
    if (action === 'remove') state.sql.remove(id as any)
    else state.sql[method](id as any, { ...value, dialect: id } as any)
  } else if (name === 'calibrations') {
    if (action === 'remove') state.calibrations.remove(id!)
    else if (action === 'register') state.calibrations.register(id!, value.points, value.options)
    else state.calibrations.update({ ...value, scope: id } as any)
  } else if (name === 'behaviors') {
    if (action === 'remove') { state.behaviors.remove(id!); return }
    const template = amp.runtime.DefaultBehaviors.find(item => item.behavior.id === (value.template ?? id))
    if (!template) throw new Error('Behavior callbacks must reference an installed AMP template')
    state.behaviors[method]({ ...template, behavior: { ...template.behavior, ...value.behavior, id: id!, ...(typeof value.name === 'string' ? { name: value.name } : {}) } })
    if (value.priority !== undefined) state.behaviors.applyPriorities({ [id!]: value.priority })
  } else if (name === 'entities') {
    if (action === 'remove') state.entities.remove(id as any)
    else state.entities[method]({ ...value, name: id } as any)
  } else if (name === 'tools') {
    if (action === 'remove') { state.tools.remove(id!); state.targets.delete(id!); return }
    const target = AMP_DEFINITIONS.find(item => item.name === value.target)
    if (!target) throw new Error('Tool execution must bind an installed AMP tool; metadata cannot create code or change its risk/schema')
    if (AMP_DEFINITIONS.some(tool => tool.name === id)) throw new Error('Alias IDs cannot replace canonical AMP tool IDs')
    state.tools[method]({ name: id!, description: typeof value.description === 'string' ? value.description : target.description, inputSchema: target.inputSchema, risk: target.risk })
    state.targets.set(id!, target.name)
  }
}

function activate(state: Instances, name: Specialized) {
  const syntax = amp.syntax.DefaultSyntaxRegistry
  if (name === 'languages') { syntax.clearLanguages(); state.syntax.languages().forEach(value => syntax.registerLanguage(value)) }
  if (name === 'tokenKinds') { syntax.tokenKindsList().forEach(value => syntax.removeTokenKind(value.id)); state.syntax.tokenKindsList().forEach(value => syntax.registerTokenKind(value)) }
  if (name === 'nodeKinds') { syntax.nodeKindsList().forEach(value => syntax.removeNodeKind(value.id)); state.syntax.nodeKindsList().forEach(value => syntax.registerNodeKind(value)) }
  if (name === 'outlines') { amp.outline.DefaultOutlineRegistry.clear(); state.outlines.list().forEach(value => amp.outline.DefaultOutlineRegistry.register(value)) }
  if (name === 'outlineKeywords') {
    for (const category of categories) amp.outline.DefaultOutlineKeywords.words(category).forEach(word => amp.outline.DefaultOutlineKeywords.remove(word))
    for (const category of categories) state.keywords.words(category).forEach(word => amp.outline.DefaultOutlineKeywords.register(category, word))
  }
  if (name === 'sqlDialects') { amp.sqlOutline.DefaultSqlDialectRegistry.dialects().forEach(id => amp.sqlOutline.DefaultSqlDialectRegistry.remove(id)); state.sql.list().forEach(value => amp.sqlOutline.DefaultSqlDialectRegistry.register(value.dialect, value)) }
}

export class HostRegistries {
  constructor(private readonly database: Database, private readonly workspaceId: string) {
    database.db.exec('CREATE TABLE IF NOT EXISTS codex_registry_operations (workspace_id TEXT NOT NULL, registry TEXT NOT NULL, version INTEGER NOT NULL, operations TEXT NOT NULL, PRIMARY KEY(workspace_id, registry))')
  }
  activateStored() {
    for (const name of ['languages', 'tokenKinds', 'nodeKinds', 'outlines', 'outlineKeywords', 'sqlDialects'] as Specialized[]) {
      const state = instances()
      const stored = this.database.db.prepare('SELECT operations FROM codex_registry_operations WHERE workspace_id=? AND registry=?').get(this.workspaceId, name) as { operations: string } | undefined
      for (const operation of stored ? JSON.parse(stored.operations) : []) mutate(state, name, operation)
      activate(state, name)
    }
  }
  /** Reconstruct the exact edited registry consumed by a native runtime turn. */
  runtimeBehaviors() {
    const state = instances()
    const stored = this.database.db.prepare('SELECT operations FROM codex_registry_operations WHERE workspace_id=? AND registry=?').get(this.workspaceId, 'behaviors') as { operations: string } | undefined
    for (const operation of stored ? JSON.parse(stored.operations) : []) mutate(state, 'behaviors', operation)
    return state.behaviors
  }
  runtimeTools() {
    const state = instances()
    const stored = this.database.db.prepare('SELECT operations FROM codex_registry_operations WHERE workspace_id=? AND registry=?').get(this.workspaceId, 'tools') as { operations: string } | undefined
    for (const operation of stored ? JSON.parse(stored.operations) : []) mutate(state, 'tools', operation)
    return { tools: state.tools.list(), targets: state.targets }
  }
  components(): HostComponent[] {
    const components: HostComponent[] = []
    for (const name of RegistryNames.filter(name => !['skills', 'knowledge', 'protocols', 'modules', 'environments', 'concepts'].includes(name)) as Specialized[]) {
      const state = instances()
      const stored = this.database.db.prepare('SELECT operations FROM codex_registry_operations WHERE workspace_id=? AND registry=?').get(this.workspaceId, name) as { operations: string } | undefined
      for (const operation of stored ? JSON.parse(stored.operations) : []) mutate(state, name, operation)
      for (const entry of list(state, name)) components.push({ id: `amp.registry.${name}.${amp.semantic.digestOf(entry.id).slice(7, 31)}`, kind: name === 'tools' ? 'tool' : 'module', name: String(entry.name ?? entry.id), description: typeof entry.description === 'string' ? entry.description : `AMP ${name} entry ${entry.id}`, projectId: 'project:.', capabilities: [`registry:${name}`, `entry:${entry.id}`, 'coordination_registry'] })
    }
    return components
  }
  async call(args: Record<string, any>, invoke: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    const name = args.registry as Specialized
    if (!RegistryNames.includes(name) || ['skills', 'knowledge', 'protocols', 'modules', 'environments', 'concepts'].includes(name)) throw new Error('Use the canonical adjust tools for this registry')
    canonicalJson(args)
    const stored = this.database.db.prepare('SELECT version, operations FROM codex_registry_operations WHERE workspace_id=? AND registry=?').get(this.workspaceId, name) as { version: number; operations: string } | undefined
    const version = stored?.version ?? 0
    const operations: Operation[] = stored ? JSON.parse(stored.operations) : []
    const state = instances()
    for (const operation of operations) mutate(state, name, operation)
    const entries = list(state, name)
    if (args.action === 'list') return { ok: true, registry: name, version, entries }
    if (args.action === 'get') return { ok: true, registry: name, version, entry: entries.find(entry => entry.id === args.id) ?? null }
    if (args.action === 'invoke' && name === 'tools') {
      const target = state.targets.get(args.id)
      if (!target) throw new Error('Unknown registered tool')
      return invoke(target, args.arguments ?? {})
    }
    if (args.action === 'invoke' && name === 'calibrations') return { ok: true, registry: name, value: state.calibrations.calibrate(args.id, args.arguments?.predicted) }
    if (args.action === 'invoke' && name === 'sqlDialects') return { ok: true, registry: name, dialect: state.sql.detect(String(args.arguments?.text ?? '')), scores: Object.fromEntries(state.sql.scores(String(args.arguments?.text ?? ''))) }
    if (args.action === 'invoke' && name === 'behaviors') return { ok: true, registry: name, plan: state.behaviors.select(args.arguments as any) }
    if (args.action === 'invoke' && name === 'outlineKeywords') return { ok: true, registry: name, category: state.keywords.categoryOf(String(args.arguments?.word)) ?? null, modifiers: state.keywords.leadingModifiers(String(args.arguments?.text ?? '')) }
    if (args.action === 'invoke' && name === 'languages') return { ok: true, registry: name, language: state.syntax.languageOf(String(args.arguments?.path ?? '')), rule: state.syntax.ruleOf(args.id), keywords: [...state.syntax.keywordsOf(args.id)] }
    if (args.action === 'invoke' && name === 'tokenKinds') return { ok: true, registry: name, registered: state.syntax.hasTokenKind(args.id) }
    if (args.action === 'invoke' && name === 'nodeKinds') return { ok: true, registry: name, registered: state.syntax.hasNodeKind(args.id) }
    if (args.action === 'invoke' && name === 'entities') { const entry = state.entities.get(args.id); if (!entry) fail(ERROR_CODES.NOT_FOUND, 'Unknown entity'); return { ok: true, registry: name, table: amp.database.toTableMeta(entry) } }
    if (args.action === 'invoke' && name === 'outlines') {
      if (args.id !== undefined && !entries.some(entry => entry.id === args.id)) fail(ERROR_CODES.NOT_FOUND, 'Unknown outline strategy')
      const result = await invoke('amp_tool_filesystem_outline', args.arguments ?? {})
      if (result.ok !== false && args.id !== undefined && (result.data as any)?.strategy !== args.id) fail(ERROR_CODES.INVALID_ARGUMENT, 'The native registry selected a different strategy for this path', { requested: args.id, selected: (result.data as any)?.strategy })
      return result
    }
    if (args.expectedVersion !== undefined && args.expectedVersion !== version) fail(ERROR_CODES.CONFLICT, `version_conflict: expected ${args.expectedVersion}, current ${version}`)
    if (!['register', 'update', 'remove', 'clear'].includes(args.action)) throw new Error('Unsupported registry action')
    if (args.action !== 'clear' && (typeof args.id !== 'string' || !args.id.trim())) throw new Error('A registry entry ID is required')
    if (args.value?.id !== undefined && args.value.id !== args.id) throw new Error('Registry entry ID mismatch')
    if (args.value?.behavior?.id !== undefined && args.value.behavior.id !== args.id) fail(ERROR_CODES.INVALID_ARGUMENT, 'Behavior identity differs from id')
    const identity = name === 'entities' || name === 'tools' ? 'name' : name === 'calibrations' ? 'scope' : name === 'sqlDialects' ? 'dialect' : undefined
    if (identity && args.value?.[identity] !== undefined && args.value[identity] !== args.id) fail(ERROR_CODES.INVALID_ARGUMENT, 'Registry identity field differs from id')
    if (['tools', 'outlines', 'behaviors'].includes(name) && Object.keys(args.value ?? {}).some(key => ['code', 'script', 'handler', 'parse', 'matches', 'match', 'risk', 'inputSchema'].includes(key))) fail(ERROR_CODES.INVALID_ARGUMENT, 'Executable callbacks and tool risk/schema are host-bound')
    if (name === 'tools' && Object.keys(args.value ?? {}).some(key => !['id', 'name', 'target', 'description'].includes(key))) fail(ERROR_CODES.INVALID_ARGUMENT, 'Tool aliases accept only identity, target and description metadata')
    if (name === 'calibrations' && args.action === 'register') args = { ...args, value: { ...args.value, options: { ...args.value?.options, at: args.value?.options?.at ?? new Date().toISOString() } } }
    const operation: Operation = { action: args.action, ...(args.id ? { id: args.id } : {}), ...(args.value ? { value: args.value } : {}) }
    try { mutate(state, name, operation) } catch (error) { fail(ERROR_CODES.INVALID_ARGUMENT, error instanceof Error ? error.message : String(error), { registry: name, action: args.action }) }
    const next = list(state, name)
    if (!args.dryRun) {
      this.database.transaction(() => {
        const current = this.database.db.prepare('SELECT version FROM codex_registry_operations WHERE workspace_id=? AND registry=?').get(this.workspaceId, name) as { version: number } | undefined
        if ((current?.version ?? 0) !== version) throw new Error('version_conflict')
        this.database.db.prepare('INSERT INTO codex_registry_operations VALUES(?,?,?,?) ON CONFLICT(workspace_id,registry) DO UPDATE SET version=excluded.version,operations=excluded.operations').run(this.workspaceId, name, version + 1, JSON.stringify([...operations, operation]))
        this.database.objectService.put('registry-revision', `${this.workspaceId}.${name}.${version + 1}`, { registry: name, operation }, new Date().toISOString())
      })
      activate(state, name)
    }
    return { ok: true, registry: name, version: version + 1, dryRun: args.dryRun === true, entries: next }
  }
}
