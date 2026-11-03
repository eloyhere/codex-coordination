import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { PeriodicityAlert as Alert, PeriodicityButton as Button, PeriodicityDialog as Dialog, PeriodicityPopover as Popover, PeriodicitySnackbar as Snackbar } from 'periodicity-react'

type Surface = 'snackbar' | 'popover' | 'dialog' | 'alert'
type Anchor = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'
interface Notification {
  id: string; surface: Surface; message: string; title: string
  severity: 'info' | 'success' | 'warning' | 'error'; anchor: Anchor; duration: number
  actions: { id: string; label: string }[]
}
const surfaces: Surface[] = ['snackbar', 'popover', 'dialog', 'alert']
const anchors: Anchor[] = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']

export function useNotifications() {
  const [items, setItems] = useState<Notification[]>([])
  const seen = useRef(new Set<string>())
  const receive = useCallback((input: unknown[]) => {
    const next: Notification[] = []
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') continue
      const n = raw as Record<string, unknown>
      if (typeof n.id !== 'string' || typeof n.message !== 'string' || !surfaces.includes(n.surface as Surface) || seen.current.has(n.id)) continue
      seen.current.add(n.id)
      if (seen.current.size > 256) seen.current.delete(seen.current.values().next().value!)
      next.push({ id: n.id, surface: n.surface as Surface, message: n.message, title: typeof n.title === 'string' ? n.title : '通知',
        severity: ['success', 'warning', 'error'].includes(String(n.severity)) ? n.severity as Notification['severity'] : 'info',
        anchor: anchors.includes(n.anchor as Anchor) ? n.anchor as Anchor : 'bottom-right',
        duration: typeof n.duration === 'number' && Number.isFinite(n.duration) ? Math.max(0, n.duration) : n.surface === 'dialog' ? 0 : 5000,
        actions: Array.isArray(n.actions) ? n.actions.filter((a): a is { id: string; label: string } => a && typeof a.id === 'string' && typeof a.label === 'string').slice(0, 4) : [],
      })
    }
    if (next.length) setItems(queue => [...queue, ...next].slice(0, 128))
  }, [])
  const dismiss = useCallback((id: string) => setItems(queue => queue.filter(item => item.id !== id)), [])
  return { items, receive, dismiss }
}

function position(anchor: Anchor): CSSProperties {
  const [vertical, horizontal] = anchor.split('-')
  return { top: vertical === 'top' ? 'calc(16px + var(--safe-top))' : 'auto', bottom: vertical === 'bottom' ? 'calc(16px + var(--safe-bottom))' : 'auto',
    left: horizontal === 'left' ? 'calc(16px + var(--safe-left))' : horizontal === 'center' ? '50%' : 'auto',
    right: horizontal === 'right' ? 'calc(16px + var(--safe-right))' : 'auto', transform: horizontal === 'center' ? 'translateX(-50%)' : 'none' }
}

export function NotificationCenter({ items, dismiss }: { items: Notification[]; dismiss(id: string): void }) {
  // One visible surface at a time: queued dialogs never compete for focus.
  const item = items[0]
  const id = item?.id
  const close = useCallback(() => { if (id) dismiss(id) }, [id, dismiss])
  return item ? <NotificationSurface key={item.id} item={item} dismiss={close} /> : null
}

function NotificationSurface({ item, dismiss }: { item: Notification; dismiss(): void }) {
  const anchor = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (item.duration <= 0) return
    const timer = window.setTimeout(dismiss, item.duration)
    return () => window.clearTimeout(timer)
  }, [item.id, item.duration, dismiss])
  const tone = item.severity === 'error' ? 'danger' : item.severity === 'info' ? 'neutral' : item.severity
  const actions = <div className="notification-actions">{item.actions.map(action => <Button key={action.id} variant="outline" onClick={dismiss}>{action.label}</Button>)}</div>
  const body = <div className="notification-body"><strong>{item.title}</strong><p>{item.message}</p>{actions}</div>
  if (item.surface === 'dialog') return <Dialog open onClose={dismiss} title={item.title} closeLabel="关闭通知" role={item.severity === 'error' ? 'alertdialog' : 'dialog'} className="notification-dialog" data-notification-tone={tone} data-notification-surface="dialog" footer={item.actions.length ? actions : undefined}><p className="notification-message">{item.message}</p></Dialog>
  if (item.surface === 'snackbar') return <Snackbar open onClose={dismiss} onOpenChange={open => { if (!open) dismiss() }} autoHideDuration={0} tone={tone} message={body} style={position(item.anchor)} data-notification-surface="snackbar" />
  if (item.surface === 'alert') return <div className="notification-layer" style={position(item.anchor)} data-notification-surface="alert"><Alert tone={tone} title={item.title} description={<span className="notification-message">{item.message}</span>} action={actions} dismissible onDismiss={dismiss} role="alert" /></div>
  const top = item.anchor.startsWith('top')
  const align = item.anchor.endsWith('left') ? 'start' : item.anchor.endsWith('right') ? 'end' : 'center'
  const placement = `${top ? 'bottom' : 'top'}${align === 'center' ? '' : '-' + align}` as 'bottom' | 'top' | 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  return <><span ref={anchor} className="notification-anchor" style={position(item.anchor)} aria-hidden="true" /><Popover open anchorRef={anchor} placement={placement} offset={0} onClose={dismiss} ariaLabel={item.title} className="notification-popover" data-notification-tone={tone} data-notification-surface="popover">{body}<Button variant="ghost" onClick={dismiss}>关闭通知</Button></Popover></>
}
