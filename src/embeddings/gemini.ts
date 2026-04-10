import { GoogleGenAI } from "@google/genai";
import { env } from "../config.js";

const genai = new GoogleGenAI({ apiKey: env.googleApiKey });

const MODEL = "gemini-embedding-001";
const DIMENSIONS = 3072;
const BATCH_SIZE = 20; // Smaller batches to avoid rate limits
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

/**
 * Retry wrapper with exponential backoff for rate limit errors.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isRateLimit =
        err instanceof Error &&
        (err.message.includes("429") ||
          err.message.includes("Resource exhausted") ||
          err.message.includes("rate"));

      if (!isRateLimit || attempt === MAX_RETRIES - 1) throw err;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(
        `[Embedding] Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

/**
 * Embed a single text string into a 3072-dimensional vector.
 */
export async function embedText(text: string): Promise<number[]> {
  return withRetry(async () => {
    const result = await genai.models.embedContent({
      model: MODEL,
      contents: text,
      config: { outputDimensionality: DIMENSIONS },
    });
    return result.embeddings![0]!.values!;
  });
}

/**
 * Embed multiple texts in batches.
 * Uses smaller batches + sequential processing to respect rate limits.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // Process batch sequentially to avoid parallel rate limit hits
    for (const text of batch) {
      const emb = await embedText(text);
      results.push(emb);
    }
    // Small delay between batches
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}

/**
 * Estimate token count from text (rough heuristic).
 * ~1 token per 4 characters for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
