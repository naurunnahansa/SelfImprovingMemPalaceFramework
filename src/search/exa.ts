import { Exa } from "exa-js";
import { env } from "../config.js";

const exa = new Exa(env.exaApiKey);

export interface ExaResult {
  title: string;
  url: string;
  text: string;
  highlights: string[];
  publishedDate: string | null;
}

/**
 * Search the web using Exa and return results with content.
 */
export async function searchWeb(
  query: string,
  options: {
    numResults?: number;
    type?: "auto" | "neural" | "keyword";
    category?: string;
  } = {}
): Promise<ExaResult[]> {
  const results = await exa.searchAndContents(query, {
    type: options.type ?? "auto",
    numResults: options.numResults ?? 5,
    text: { maxCharacters: 2000 },
    highlights: { numSentences: 3 },
    ...(options.category ? { category: options.category as "company" | "research paper" | "news" | "pdf" | "personal site" } : {}),
  });

  return results.results.map((r) => ({
    title: r.title ?? "",
    url: r.url,
    text: r.text ?? "",
    highlights: r.highlights ?? [],
    publishedDate: r.publishedDate ?? null,
  }));
}
