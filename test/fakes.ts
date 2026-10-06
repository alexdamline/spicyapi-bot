import type { ApiModel, CreateTaskResult, TaskQuote, TaskRecord } from "@spicyapi/sdk";
import { vi } from "vitest";
import { loadConfig, type BotConfig } from "../src/config.js";
import type { SpicyApi } from "../src/core/bot-core.js";

export const NOW = Date.parse("2026-10-06T12:00:00Z");

export function quote(overrides: Partial<TaskQuote> = {}): TaskQuote {
  return {
    quoteId: "q_1",
    model: "example/image-model/text-to-image",
    estimatedCost: "0.01",
    maxCharge: "0.01",
    currency: "USD",
    quantity: "1",
    unit: "per_image",
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

export function accepted(overrides: Partial<CreateTaskResult> = {}): CreateTaskResult {
  return {
    taskId: "job_test1",
    state: "queued",
    estimatedCost: "0.01",
    deadlineAt: new Date(NOW + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

export function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "job_test1",
    model: "example/image-model/text-to-image",
    state: "succeeded",
    cost: "0.01",
    settled: true,
    createdAt: new Date(NOW).toISOString(),
    output: { assets: [{ url: "https://files.example.test/result.png", mime: "image/png", bytes: 1000 }] },
    ...overrides,
  };
}

export const IMAGE_SCHEMA = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string", "x-ui": { widget: "textarea", primary: true } },
    aspect_ratio: { type: "string", enum: ["1:1", "16:9", "9:16"], default: "1:1" },
    seed: { type: "integer" },
  },
};

export const I2V_SCHEMA = {
  type: "object",
  required: ["prompt", "image_url"],
  properties: {
    prompt: { type: "string", "x-ui": { widget: "textarea", primary: true } },
    image_url: { type: "string", format: "uri", "x-ui": { widget: "upload" } },
    last_image_url: { type: "string", format: "uri", "x-ui": { widget: "upload" } },
    duration_seconds: { type: "integer", default: 5, minimum: 4, maximum: 15 },
    resolution: { type: "string", enum: ["480p", "768p", "2k"], default: "768p" },
  },
};

export function model(overrides: Partial<ApiModel> = {}): ApiModel {
  return {
    model: "example/image-model/text-to-image",
    family: "example/image-model",
    displayName: "Example Image",
    provider: "example",
    modality: "image",
    tasks: ["text-to-image"],
    async: true,
    mature: false,
    policyTier: "unrestricted",
    taskTimeoutSeconds: 600,
    enabled: true,
    available: true,
    quantityField: "",
    pricing: [{ variant: "", unit: "per_image", price: "0.01", currency: "USD" }],
    startingPrice: { variant: "", unit: "per_image", price: "0.01", currency: "USD" },
    inputSchema: IMAGE_SCHEMA,
    version: "1",
    availability: "available",
    badges: [],
    relatedModels: [],
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

/** A SpicyAPI stand-in: every method is a vi.fn with a sensible default. */
export function fakeSpicy(models: ApiModel[] = [model()]) {
  return {
    quoteTask: vi.fn<SpicyApi["quoteTask"]>(async () => quote()),
    createTask: vi.fn<SpicyApi["createTask"]>(async () => accepted()),
    waitForTask: vi.fn<SpicyApi["waitForTask"]>(async () => task()),
    getTask: vi.fn<SpicyApi["getTask"]>(async () => task()),
    listModels: vi.fn<SpicyApi["listModels"]>(async () => ({ total: models.length, items: models })),
    getModel: vi.fn<SpicyApi["getModel"]>(async (id: string) => models.find((item) => item.model === id) ?? models[0]!),
    getBalance: vi.fn<SpicyApi["getBalance"]>(async () => ({ available: "12.5", held: "0", total: "12.5" })),
    uploadBytes: vi.fn<SpicyApi["uploadBytes"]>(async () => ({
      fileId: "fil_1",
      status: "ready" as const,
      bytes: 10,
      contentType: "image/png" as const,
      sha256: "x",
      uri: "spicy://f/fil_1",
      expiresAt: new Date(NOW + 86_400_000).toISOString(),
    })),
  } satisfies Record<keyof SpicyApi, unknown>;
}

export function testConfig(env: Record<string, string> = {}): BotConfig {
  return loadConfig({
    SPICY_API_KEY: "sk-spicy-test",
    TELEGRAM_BOT_TOKEN: "123:abc",
    OWNER_ID: "111",
    ...env,
  }).config;
}
