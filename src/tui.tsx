/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { Quota } from "./rpc.js"
import type { QuotaState, QuotaWindow } from "./rpc.js"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

const EMPTY: QuotaState = { updatedAt: 0, windows: {} }

function formatClock(ms: number): string {
  const date = new Date(ms)
  const now = new Date()
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  if (date.toDateString() === now.toDateString()) return time
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${time}`
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function formatAgo(ms: number): string {
  if (ms <= 0) return "尚无数据"
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (seconds < 15) return "刚刚"
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function levelColor(theme: AnyRecord, w: QuotaWindow): string {
  const ratio = w.limit > 0 ? w.remaining / w.limit : 1
  if (ratio < 0.25) return theme.error?.text ?? theme.error ?? "#f87171"
  if (ratio < 0.5) return theme.warning?.text ?? theme.warning ?? "#e3b341"
  return theme.text?.muted ?? theme.text?.base ?? "#888888"
}

function bar(w: QuotaWindow, width = 12): string {
  const ratio = w.limit > 0 ? w.remaining / w.limit : 1
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export default Plugin.define({
  id: "gwdg-quota.tui",
  setup(context) {
    const theme = (context.theme ?? {}) as AnyRecord
    const [quota, setQuota] = createSignal<QuotaState>(EMPTY)
    const [refreshing, setRefreshing] = createSignal(false)

    const rpc = context.client.rpc(Quota)

    // Initial value from the server plugin (persisted across restarts).
    void (async () => {
      try {
        const result = await rpc.get({})
        if (result != null && typeof result === "object") setQuota(result as QuotaState)
      } catch {
        // Server plugin not reachable yet; the event subscription recovers.
      }
    })()

    // Live updates after every real API call.
    const stopEvents = rpc.events.on("updated", (event: AnyRecord) => {
      const data = event?.data
      if (data != null && typeof data === "object") setQuota(data as QuotaState)
    })

    const refresh = async () => {
      if (refreshing()) return
      setRefreshing(true)
      try {
        const result = await rpc.refresh({})
        if (result != null && typeof result === "object") setQuota(result as QuotaState)
        context.ui.toast.show({ title: "GWDG 配额", message: "已刷新（消耗 1 次调用）", variant: "success" })
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const err = error as AnyRecord
        const message = err?.body?.data?.message ?? err?.data?.message ?? err?.message ?? String(error)
        context.ui.toast.show({ title: "GWDG 配额", message: `刷新失败: ${message}`, variant: "error" })
      } finally {
        setRefreshing(false)
      }
    }

    const StatusBar = () => {
      const state = quota()
      // Hide the status bar entirely when the GWDG provider is not configured.
      if (state.providerConfigured === false) return null
      // Hide when the currently selected model belongs to another provider.
      const model = context.ui.model.current()
      if (model && state.providerID !== undefined && model.providerID !== state.providerID) return null
      const hour = state.windows.hour
      const day = state.windows.day
      if (!hour && !day) {
        return (
          <text fg={theme.text?.muted}>&#9889; API --</text>
        )
      }
      return (
        <box flexDirection="row">
          <text fg={theme.text?.muted}>&#9889; </text>
          {hour ? (
            <text fg={levelColor(theme, hour)}>
              {`${hour.remaining}/${hour.limit}h`}
              {day ? " " : ""}
            </text>
          ) : null}
          {day ? <text fg={levelColor(theme, day)}>{`${day.remaining}/${day.limit}d`}</text> : null}
        </box>
      )
    }

    const QuotaDialog = () => {
      context.keymap.layer(() => ({
        commands: [
          {
            id: "gwdg-quota.refresh",
            title: "刷新配额（消耗 1 次调用）",
            bind: "r",
            run: () => void refresh(),
          },
        ],
      }))
      const state = quota()
      const rows: Array<{ label: string; w?: QuotaWindow }> = [
        { label: "10 秒窗口", w: state.windows["10s"] },
        { label: "小时窗口", w: state.windows.hour },
        { label: "天窗口  ", w: state.windows.day },
      ]
      return (
        <box flexDirection="column" padding={1}>
          <text fg={theme.text?.base}>GWDG SAIA 剩余调用次数</text>
          <text> </text>
          {rows.map((row) =>
            row.w ? (
              <box flexDirection="row">
                <text fg={theme.text?.base}>{`${row.label}  `}</text>
                <text fg={levelColor(theme, row.w)}>{bar(row.w)}</text>
                <text fg={levelColor(theme, row.w)}>{`  ${row.w.remaining}/${row.w.limit}`}</text>
                <text fg={theme.text?.muted}>{`  重置于 ${formatClock(row.w.resetAt)}`}</text>
              </box>
            ) : (
              <box flexDirection="row">
                <text fg={theme.text?.muted}>{`${row.label}  `}</text>
                <text fg={theme.text?.muted}>--</text>
              </box>
            ),
          )}
          <text> </text>
          <text fg={theme.text?.muted}>{`上次更新: ${formatAgo(state.updatedAt)}（每次 API 调用后自动跟踪）`}</text>
          <text fg={theme.text?.muted}>{refreshing() ? "正在刷新…" : "r 刷新（消耗 1 次调用）  ·  esc 关闭"}</text>
        </box>
      )
    }

    const showQuotaDialog = () => {
      context.ui.dialog.set({ size: "large", centered: true })
      context.ui.dialog.show(() => <QuotaDialog />, () => {})
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "gwdg-quota.show",
          title: "GWDG API 剩余调用次数",
          group: "GWDG",
          palette: true,
          slash: { name: "quota", arguments: true },
          suggested: true,
          enabled: () => {
            const state = quota()
            if (state.providerConfigured === false) return false
            const model = context.ui.model.current()
            if (model && state.providerID !== undefined && model.providerID !== state.providerID) return false
            return true
          },
          run: (input?: string) => {
            if (input && input.trim() === "refresh") void refresh()
            else showQuotaDialog()
          },
        },
      ],
    }))

    const stopHomeSlot = context.ui.slot({
      append: "home.footer.status",
      render: () => <StatusBar />,
    })
    const stopPromptSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <StatusBar />,
    })

    return () => {
      stopEvents()
      stopHomeSlot()
      stopPromptSlot()
    }
  },
})
