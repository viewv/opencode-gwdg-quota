import { createSignal } from "solid-js"
import { Command, ComposerPill, Plugin } from "@opencode/plugin/gui"
import { Quota } from "./rpc.js"
import type { QuotaState, QuotaWindow } from "./rpc.js"

type PillTone = "success" | "warning" | "danger"

const EMPTY: QuotaState = { updatedAt: 0, windows: {} }

type Translate = (key: string) => string

function formatClock(t: Translate, ms: number, withSeconds = false): string {
  const date = new Date(ms)
  const now = new Date()
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  const ss = String(date.getSeconds()).padStart(2, "0")
  const time = withSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`
  if (date.toDateString() === now.toDateString()) return time
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (date.toDateString() === tomorrow.toDateString()) return `${t("clock.tomorrow")} ${time}`
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function formatAgo(t: Translate, ms: number): string {
  if (ms <= 0) return t("ago.never")
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (seconds < 15) return t("ago.justNow")
  if (seconds < 60) return `${seconds} ${t("unit.secondsAgo")}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} ${t("unit.minutesAgo")}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${t("unit.hoursAgo")}`
  return `${Math.floor(hours / 24)} ${t("unit.daysAgo")}`
}

function ratio(w: QuotaWindow): number {
  return w.limit > 0 ? w.remaining / w.limit : 1
}

function tone(w?: QuotaWindow): PillTone | undefined {
  if (!w) return undefined
  const r = ratio(w)
  if (r < 0.25) return "danger"
  if (r < 0.5) return "warning"
  return "success"
}

function worstTone(ws: Array<QuotaWindow | undefined>): PillTone | undefined {
  const tones = ws.filter(Boolean).map((w) => tone(w)).filter(Boolean) as PillTone[]
  if (tones.length === 0) return undefined
  if (tones.includes("danger")) return "danger"
  if (tones.includes("warning")) return "warning"
  return "success"
}

export default Plugin.define({
  i18n: {
    en: {
      "pill.title": "GWDG SAIA remaining API quota (auto-tracked)",
      "pill.empty": "API --",
      "window.10s": "10 sec",
      "window.hour": "Hour",
      "window.day": "Day",
      "updated": "Updated",
      "ago.never": "no data yet",
      "ago.justNow": "just now",
      "unit.secondsAgo": "sec ago",
      "unit.minutesAgo": "min ago",
      "unit.hoursAgo": "hr ago",
      "unit.daysAgo": "days ago",
      "resets": "resets at",
      "clock.tomorrow": "tomorrow",
      "refresh": "Refresh (uses 1 request)",
      "refreshing": "Refreshing…",
      "command.title": "GWDG API remaining quota",
      "command.description": "Send one minimal probe request to refresh the quota (uses 1 request)",
    },
    zh: {
      "pill.title": "GWDG SAIA 剩余调用次数（自动跟踪每次调用）",
      "pill.empty": "API --",
      "window.10s": "10 秒",
      "window.hour": "小时",
      "window.day": "天",
      "updated": "上次更新",
      "ago.never": "尚无数据",
      "ago.justNow": "刚刚",
      "unit.secondsAgo": "秒前",
      "unit.minutesAgo": "分钟前",
      "unit.hoursAgo": "小时前",
      "unit.daysAgo": "天前",
      "resets": "重置于",
      "clock.tomorrow": "明天",
      "refresh": "刷新（消耗 1 次调用）",
      "refreshing": "正在刷新…",
      "command.title": "GWDG API 剩余调用次数",
      "command.description": "发送一次最小探测请求刷新配额（消耗 1 次调用）",
    },
  },
  setup(ctx) {
    const t = (key: string) => ctx.t(key)

    const [quota, setQuota] = createSignal<QuotaState>(EMPTY)
    const [refreshing, setRefreshing] = createSignal(false)

    const load = async () => {
      try {
        const result = await ctx.client.rpc(Quota).get({})
        if (result != null && typeof result === "object") setQuota(result as QuotaState)
      } catch {
        // The server plugin may not be ready yet; the next poll retries.
      }
    }
    void load()

    let stopEvents: (() => void) | undefined
    const subscribe = () => {
      try {
        stopEvents = ctx.client.rpc(Quota).events.on("updated", (event: { data?: QuotaState }) => {
          if (event?.data != null && typeof event.data === "object") setQuota(event.data)
        })
      } catch {
        // Ignore; the interval poll below recovers.
      }
    }
    subscribe()

    // Poll often: the RPC now aggregates state from a shared file, so this is
    // a cheap local call that survives server restarts and location changes.
    const timer = setInterval(() => void load(), 30 * 1000)

    const refresh = async () => {
      if (refreshing()) return
      setRefreshing(true)
      try {
        const result = await ctx.client.rpc(Quota).refresh({})
        if (result != null && typeof result === "object") setQuota(result as QuotaState)
      } catch {
        // Keep showing the last known state.
      } finally {
        setRefreshing(false)
      }
    }

    ctx.add(ComposerPill, {
      id: "quota",
      show: () => {
        const state = quota()
        // Hide the pill entirely when the GWDG provider is not configured.
        if (state.providerConfigured === false) return undefined
        const ten = state.windows["10s"]
        const hour = state.windows.hour
        const day = state.windows.day
        const parts: string[] = []
        if (hour) parts.push(`${hour.remaining}/${hour.limit}h`)
        if (day) parts.push(`${day.remaining}/${day.limit}d`)
        const rows: Array<{ id: string; label: string; tone: PillTone; detail?: string }> = []
        const row = (id: string, name: string, w: QuotaWindow, withSeconds = false) => ({
          id,
          label: `${name}  ${w.remaining}/${w.limit}`,
          tone: tone(w) ?? "success",
          detail: `${t("resets")} ${formatClock(t, w.resetAt, withSeconds)}`,
        })
        if (ten) rows.push(row("10s", t("window.10s"), ten, true))
        if (hour) rows.push(row("hour", t("window.hour"), hour))
        if (day) rows.push(row("day", t("window.day"), day))
        rows.push({
          id: "updated",
          label: `${t("updated")}: ${formatAgo(t, state.updatedAt)}`,
          tone: "success",
        })
        return {
          icon: "zap",
          label: parts.length > 0 ? parts.join(" · ") : t("pill.empty"),
          tone: worstTone([ten, hour, day]),
          title: t("pill.title"),
          rows: [
            ...rows,
            {
              id: "refresh",
              label: refreshing() ? t("refreshing") : t("refresh"),
              icon: "refresh-cw",
              run: () => void refresh(),
            },
          ],
        }
      },
    })

    ctx.add(Command, (): Command => ({
      id: "quota",
      title: t("command.title"),
      description: t("command.description"),
      keywords: "quota gwdg api",
      group: "GWDG",
      slash: { name: "quota", arguments: true },
      enabled: quota().providerConfigured !== false,
      run: () => void refresh(),
    }))

    return () => {
      stopEvents?.()
      clearInterval(timer)
    }
  },
})
