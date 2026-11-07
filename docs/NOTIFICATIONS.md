# 通知 UI 已移除

根据用户要求，插件仅保留设置页。snackbar、popover、dialog、alert、AMP 状态行及会话详情弹窗不再展示。

coordination_notification 保留为兼容接口，返回 displayed:false 和空 notifications，不挂载 MCP App、不排队、不弹窗，也不构成审批。

后端业务工具、历史数据和真正的宿主审批接口不受此 UI 改动影响。
