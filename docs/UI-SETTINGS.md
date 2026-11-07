# Settings-only plugin UI

User preference: remove plugin popups and notification UI; retain settings only.

- The MCP App contains project selection plus registry, environment, connection
  and key configuration. Business tools and stored data remain available to
  agents, independently of this interface.
- The AMP status row, session-detail dialog and notification components are
  deleted. No status polling or notification forwarding remains in the UI.
- Existing notification tool names remain compatible but have no MCP App UI
  metadata. The public notification tool returns `displayed:false` and an empty
  notification list without calling the old notification queue.
- Legacy host-pushed dialog/snackbar payloads are ignored by the settings UI.
- Actual native host approval/elicitation remains a separate permission
  mechanism and is not disabled by removing notification presentation.

The browser suite verifies desktop/mobile settings, configuration readback,
legacy notification suppression and absence of dialog/notification/status UI.
The compatibility resource/tool name `coordination_dashboard` remains stable;
its visible title and rendered content now identify AMP settings.
