import { Rpc } from "@opencode/plugin/rpc"

// One rate-limit window, e.g. hour: { limit: 400, remaining: 327 }
const windowSchema = {
  type: "object",
  properties: {
    limit: { type: "number" },
    remaining: { type: "number" },
    resetAt: { type: "number", description: "Epoch ms when the window resets" },
  },
  required: ["limit", "remaining", "resetAt"],
  additionalProperties: false,
}

const quotaSchema = {
  type: "object",
  properties: {
    updatedAt: { type: "number", description: "Epoch ms of the last header observation" },
    providerConfigured: { type: "boolean", description: "Whether the target provider exists in the user's config" },
    windows: {
      type: "object",
      properties: {
        "10s": windowSchema,
        hour: windowSchema,
        day: windowSchema,
      },
      additionalProperties: false,
    },
  },
  required: ["updatedAt", "windows", "providerConfigured"],
  additionalProperties: false,
}

export type QuotaWindow = { limit: number; remaining: number; resetAt: number }
export type QuotaState = {
  updatedAt: number
  providerConfigured?: boolean
  windows: { "10s"?: QuotaWindow; hour?: QuotaWindow; day?: QuotaWindow }
}

export const Quota = Rpc.define({
  id: "gwdg-quota",
  methods: {
    // Returns the latest observed quota state (may be a cached value).
    get: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: quotaSchema,
      errors: {},
    },
    // Sends one tiny real request (max_tokens=1) to read fresh rate-limit
    // headers. This consumes one request of the API quota.
    refresh: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: quotaSchema,
      errors: {
        no_api_key: {
          type: "object",
          properties: { providerID: { type: "string" } },
          required: ["providerID"],
          additionalProperties: false,
        },
        probe_failed: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
  },
  events: {
    updated: { schema: quotaSchema },
  },
})
