import { GoogleGenAI } from "@google/genai";
import { env } from "../config.js";

const genai = new GoogleGenAI({ apiKey: env.googleApiKey });

const MODEL = "gemini-embedding-001";
const DIMENSIONS = 3072;
const BATCH_SIZE = 100;

/**
 * Embed a single text string into a 3072-dimensional vector.
 */
export async function embedText(text: string): Promise<number[]> {
  const result = await genai.models.embedContent({
    model: MODEL,
    contents: text,
    config: { outputDimensionality: DIMENSIONS },
  });
  return result.embeddings![0]!.values!;
}

/**
 * Embed multiple texts in batches of 100.
 * Returns vectors in the same order as input.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((text) => embedText(text))
    );
    results.push(...batchResults);
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
