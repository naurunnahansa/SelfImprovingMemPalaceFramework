import "dotenv/config";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

type ModelRole = "main" | "fast";

const providers = {
  google: () =>
    createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY }),
  anthropic: () => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  openai: () => createOpenAI({ apiKey: process.env.OPENAI_API_KEY }),
} as const;

type ProviderName = keyof typeof providers;

function parseModelString(envVar: string): {
  provider: ProviderName;
  model: string;
} {
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`Missing environment variable: ${envVar}`);
  }
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid model format "${value}" in ${envVar}. Expected "provider:model" (e.g., "google:gemini-2.5-pro")`
    );
  }
  const provider = value.slice(0, colonIndex) as ProviderName;
  const model = value.slice(colonIndex + 1);
  if (!(provider in providers)) {
    throw new Error(
      `Unknown provider "${provider}" in ${envVar}. Supported: ${Object.keys(providers).join(", ")}`
    );
  }
  return { provider, model };
}

const modelCache = new Map<ModelRole, LanguageModel>();

export function getModel(role: ModelRole): LanguageModel {
  const cached = modelCache.get(role);
  if (cached) return cached;

  const envVar = role === "main" ? "MAIN_MODEL" : "FAST_MODEL";
  const { provider, model: modelName } = parseModelString(envVar);
  const providerInstance = providers[provider]();
  const model = providerInstance(modelName) as LanguageModel;

  modelCache.set(role, model);
  return model;
}

export const env = {
  databaseUrl: process.env.DATABASE_URL!,
  googleApiKey: process.env.GOOGLE_API_KEY!,
  exaApiKey: process.env.EXA_API_KEY!,
} as const;
