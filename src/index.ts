import { Plugin } from "@opencode/plugin"
import { Quota } from "./rpc.js"
import type { QuotaState, QuotaWindow } from "./rpc.js"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// GWDG SAIA sends Kong rate-limit headers on every successful response:
//   x-ratelimit-limit-requests-{10s,hour,day}
//   x-ratelimit-remaining-requests-{10s,hour,day}
//   x-ratelimit-reset-requests-{10s,hour,day}   (seconds until reset)
// Reading them off OpenCode's own model traffic costs nothing.

// Quota state is also mirrored to a shared file so that RPC callers routed to
// any location (project directory) always see the latest numbers, no matter
// which location actually observed the API response headers.
const STATE_FILE = join(homedir(), ".local", "share", "opencode", "gwdg-quota.json")

function isQuotaState(value: unknown): value is QuotaState {
  if (value == null || typeof value !== "object") return false
  const candidate = value as QuotaState
  return typeof candidate.updatedAt === "number" && candidate.windows != null && typeof candidate.windows === "object"
}

async function readStateFile(): Promise<QuotaState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"))
    if (isQuotaState(parsed)) return parsed
  } catch {
    // Missing or unreadable file: fall back to this location's plugin storage.
  }
  return undefined
}

async function writeStateFile(state: QuotaState): Promise<void> {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true })
    await writeFile(STATE_FILE, JSON.stringify(state), "utf8")
  } catch {
    // Best effort only; plugin storage still works for this location.
  }
}

export default Plugin.define({
  id: "gwdg-quota",
  async setup(ctx) {
    const providerID = typeof ctx.options?.providerID === "string" ? ctx.options.providerID : "gwdg"
    const probeModel =
      typeof ctx.options?.probeModel === "string" ? ctx.options.probeModel : "meta-llama-3.1-8b-instruct"

    let state: QuotaState | undefined
    const stored = (await ctx.storage.get("quota")) as QuotaState | undefined
    const fileState = await readStateFile()
    state = [stored, fileState].filter(isQuotaState).sort((a, b) => b.updatedAt - a.updatedAt)[0]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let registration: any

    const parseHeaders = (headers: Headers): QuotaState["windows"] | undefined => {
      const now = Date.now()
      const read = (name: string): number | undefined => {
        const raw = headers.get(name)
        if (raw == null) return undefined
        const value = Number(raw)
        return Number.isFinite(value) ? value : undefined
      }
      const make = (suffix: string): QuotaWindow | undefined => {
        const limit = read(`x-ratelimit-limit-requests-${suffix}`)
        const remaining = read(`x-ratelimit-remaining-requests-${suffix}`)
        if (limit === undefined || remaining === undefined) return undefined
        const reset = read(`x-ratelimit-reset-requests-${suffix}`) ?? 0
        return { limit, remaining, resetAt: now + reset * 1000 }
      }
      const windows = { "10s": make("10s"), hour: make("hour"), day: make("day") }
      const any = windows["10s"] ?? windows.hour ?? windows.day
      return any ? windows : undefined
    }

    const emptyState = (): QuotaState => ({ updatedAt: 0, windows: {} })

    // Hide the panel entirely when the target provider is not configured
    // (e.g. someone installed the plugin without using GWDG).
    const isProviderConfigured = async (): Promise<boolean> => {
      try {
        const result = (await ctx.provider.list()) as unknown
        const list = (Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? [])) as Array<
          { id?: string; provider?: { id?: string } }
        >
        return list.some((entry) => entry?.id === providerID || entry?.provider?.id === providerID)
      } catch {
        return true // Fail open: keep showing the panel on transient errors.
      }
    }

    const save = async (next: QuotaState) => {
      state = next
      await ctx.storage.set("quota", next as never)
      await writeStateFile(next)
      await registration?.events?.emit("updated", { ...next, providerConfigured: await isProviderConfigured() })
    }

    // Best of both worlds: this location's live state, or the shared file
    // written by whichever location actually saw the latest API response.
    const readBest = async (): Promise<QuotaState> => {
      const fromFile = await readStateFile()
      if ((fromFile?.updatedAt ?? 0) > (state?.updatedAt ?? 0) && fromFile) state = fromFile
      const best = state ?? emptyState()
      return { ...best, providerConfigured: await isProviderConfigured() }
    }

    // Track quota from real traffic: every response from the provider.
    const httpHook = await ctx.session.hook(
      "http.response",
      async (event) => {
        const windows = parseHeaders(event.response.headers)
        if (!windows) return
        await save({ updatedAt: Date.now(), windows })
      },
      { providerID },
    )

    registration = await ctx.rpc.register(Quota, {
      get: async () => (await readBest()) as never,
      refresh: async (_input, rpcContext) => {
        let apiKey: string | undefined
        let baseURL = "https://chat-ai.academiccloud.de/v1"
        try {
          const provider = await ctx.provider.get({ providerID })
          const record = provider as
            | { settings?: Record<string, string>; data?: { settings?: Record<string, string> } }
            | undefined
          const settings = record?.settings ?? record?.data?.settings ?? {}
          apiKey = settings.apiKey ?? process.env.GWDG_API_KEY
          if (settings.baseURL) baseURL = settings.baseURL
        } catch {
          apiKey = process.env.GWDG_API_KEY
        }
        if (!apiKey) {
          return rpcContext.error("no_api_key", `No API key found for provider ${providerID}`, { providerID })
        }
        try {
          const response = await fetch(`${baseURL.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: probeModel,
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 1,
            }),
            signal: rpcContext.signal,
          })
          const windows = parseHeaders(response.headers)
          if (windows) await save({ updatedAt: Date.now(), windows })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return rpcContext.error("probe_failed", `Quota probe request failed: ${message}`, { message })
        }
        return (await readBest()) as never
      },
    })

    return () => {
      void httpHook.dispose()
      void registration?.dispose?.()
    }
  },
})
