# Coordination plugin

This is the installable plugin directory. Build it from the repository root:

```powershell
npm ci
npm run build
```

- `.codex-plugin/plugin.json`: Codex identity, version, skills and MCP wiring.
- `.mcp.json`: Windows stdio launcher configuration.
- `mcp/`: generated TypeScript server output, with npm runtime dependencies bundled.
- `app/index.html`: generated single-file React / periodicity-react MCP App.
- `assets/THIRD_PARTY_LICENSES.md`, `app/THIRD_PARTY_LICENSES.md`: dependency notices.
- `skills/`: 13 original and copied coordination/AMP workflow skills.
- `mcp/coordination/runtime.mjs`: copies of all 24 coordination agent tools with Codex host ports.

Source lives at `src/mcp` and `src/app` in the repository root. Do not edit
built files. Node.js 24+ is required. The installed plugin needs no npm install.
The project README, docs/AMP-INTEGRATION.md and docs/COORDINATION-TOOLS.md document installation, all 98 tools,
16 editable registry families, the React workbench and host configuration.
