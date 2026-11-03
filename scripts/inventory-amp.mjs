#!/usr/bin/env node
/** Inventory the installed protocol's published runtime API without evaluating it. */
import ts from 'typescript'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

const root = dirname(fileURLToPath(import.meta.resolve('attention-manifest-protocol/package.json')))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const modules = readdirSync(join(root, 'lib'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
const files = modules.map(name => join(root, 'lib', name, 'index.d.ts'))
const program = ts.createProgram(files, { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, noEmit: true })
const checker = program.getTypeChecker()
const rows = []
const parametersOf = signature => signature.getParameters().map(parameter => {
  const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0]
  return { name: parameter.name, type: checker.typeToString(checker.getTypeOfSymbolAtLocation(parameter, declaration)), optional: Boolean(parameter.flags & ts.SymbolFlags.Optional) || Boolean(declaration?.questionToken || declaration?.initializer), rest: Boolean(declaration?.dotDotDotToken) }
})
for (const name of modules) {
  const source = program.getSourceFile(join(root, 'lib', name, 'index.d.ts'))
  if (!source) continue
  const symbol = checker.getSymbolAtLocation(source)
  if (!symbol) continue
  const exports = []
  for (let item of checker.getExportsOfModule(symbol)) {
    const exportedName = item.name
    if (item.flags & ts.SymbolFlags.Alias) item = checker.getAliasedSymbol(item)
    if (!(item.flags & ts.SymbolFlags.Value)) continue
    const declarations = item.declarations ?? []
    const declaration = declarations[0]
    if (!declaration) continue
    const type = checker.getTypeOfSymbolAtLocation(item, declaration)
    const signatures = type.getCallSignatures().map(signature => checker.signatureToString(signature))
    const constructors = type.getConstructSignatures().map(signature => checker.signatureToString(signature))
    const calls = type.getCallSignatures().map(signature => ({ signature: checker.signatureToString(signature), parameters: parametersOf(signature) }))
    const methods = {}
    const properties = {}
    if (constructors.length) {
      const instance = checker.getDeclaredTypeOfSymbol(item)
      for (const property of checker.getPropertiesOfType(instance)) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0]
        if (!declaration || declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)) continue
        const signatures = checker.getTypeOfSymbolAtLocation(property, declaration).getCallSignatures()
        const publicName = property.name.startsWith('__@iterator@') ? '$iterator' : property.name
        if (signatures.length) methods[publicName] = signatures.map(signature => ({ signature: checker.signatureToString(signature), parameters: parametersOf(signature) }))
        else properties[property.name] = { type: checker.typeToString(checker.getTypeOfSymbolAtLocation(property, declaration)), readonly: ts.isGetAccessorDeclaration(declaration) || Boolean(declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) }
      }
    }
    const members = declarations.filter(ts.isClassDeclaration).flatMap(declaration => declaration.members.filter(member => !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)).map(member => member.getText()))
    exports.push({ name: exportedName, kind: constructors.length ? 'class' : signatures.length ? 'function' : 'value', source: relative(root, declaration.getSourceFile().fileName).replaceAll('\\', '/'), signatures, constructors, calls, constructorCalls: type.getConstructSignatures().map(signature => ({ signature: checker.signatureToString(signature), parameters: parametersOf(signature) })), methods, properties, ...(members.length ? { members } : {}) })
  }
  rows.push({ module: name, import: `${pkg.name}/${name}`, exports })
}
writeFileSync(new URL('../docs/AMP-INVENTORY.json', import.meta.url), JSON.stringify({ package: pkg.name, version: pkg.version, modules: rows }, null, 2) + '\n')
writeFileSync(new URL('../src/mcp/amp/catalog.json', import.meta.url), JSON.stringify({ version: pkg.version, modules: rows.map(row => ({ module: row.module, exports: row.exports.map(({ members, ...entry }) => entry) })) }) + '\n')
const schemaFiles = readdirSync(join(root, 'docs', 'schemas')).filter(name => name.endsWith('.json')).sort()
const kinds = {}
function rootKinds(node, rootSchema) {
  if (node?.properties?.kind?.const) return [node.properties.kind.const]
  if (node?.$ref?.startsWith('#/')) return rootKinds(node.$ref.slice(2).split('/').reduce((parent, key) => parent[key], rootSchema), rootSchema)
  return ['oneOf', 'anyOf', 'allOf'].flatMap(key => (node?.[key] ?? []).flatMap(value => rootKinds(value, rootSchema)))
}
schemaFiles.forEach(name => {
  const schema = JSON.parse(readFileSync(join(root, 'docs', 'schemas', name), 'utf8'))
  rootKinds(schema, schema).forEach(kind => { kinds[kind] = name.replace('.schema.json', '') })
})
writeFileSync(new URL('../src/mcp/amp/schemas.mts', import.meta.url), '// Generated from the published AMP schemas by scripts/inventory-amp.mjs.\n' + schemaFiles.map((name, index) => `import s${index} from '${pkg.name}/schemas/${name}' with { type: 'json' }`).join('\n') + '\nexport const artifactSchemas: Record<string, any> = {\n' + schemaFiles.map((name, index) => `  '${name}': s${index},`).join('\n') + '\n}\nexport const artifactKinds: Readonly<Record<string, string>> = Object.freeze(' + JSON.stringify(kinds) + ')\n')
console.log(JSON.stringify({ modules: rows.length, runtimeExports: rows.reduce((sum, row) => sum + row.exports.length, 0), classes: rows.reduce((sum, row) => sum + row.exports.filter(item => item.kind === 'class').length, 0) }))
