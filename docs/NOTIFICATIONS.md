# Agent 通知

`coordination_notification` 在插件的 MCP App 中显示 `snackbar`、`popover`、`dialog` 或 `alert`，使用 periodicity-react 对应组件。先用 `coordination_workspace` 选择仓库；通知工具立即返回，不等待用户关闭。

```json
{
  "surface": "snackbar",
  "severity": "success",
  "title": "构建完成",
  "message": "类型检查与构建已通过。",
  "duration": 6000,
  "anchor": "bottom-right",
  "actions": [{ "id": "dismiss", "label": "知道了" }]
}
```

- `surface`：`snackbar` 短暂浮层、`popover` 角落浮卡、`dialog` 模态对话框、`alert` 警示条。
- `severity`：`info`、`success`、`warning`、`error`，默认 `info`。
- `message`：1–4000 字符，保留换行；`title` 可选，最多 200 字符。文本按普通文本渲染。
- `duration`：`0` 保留到关闭；否则为 1000–60000 毫秒。默认 snackbar 6000、alert/popover 8000、dialog 0。计时从该通知实际展示时开始。
- `anchor`：`top-left`、`top-center`、`top-right`、`bottom-left`、`bottom-center`、`bottom-right`；dialog 保持居中。
- `actions`：最多四个关闭按钮。点击只关闭通知，不触发命令、不返回回答，也不构成审批。

例如，使用 `{"surface":"dialog","title":"检查结果","message":"发现三项待处理内容。","severity":"warning","duration":0}` 显示持续对话框；将 surface 改为 `popover` 或 `alert` 可使用同一组参数。

宿主推送的工具结果与工作台内调用共用通知队列，一次展示一条；同一 ID 的重复投递不会重复显示。直接以通知工具打开 MCP App 时显示通知视图，不要求先在界面中打开台账。

显示依赖宿主对 MCP Apps 的支持，并位于插件视图内；不是操作系统通知，也不承诺在 Codex 其他区域弹窗。工具返回的 `notifications` 证明通知已交给客户端，不能证明用户已阅读或批准。
