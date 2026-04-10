import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { drawers, type Drawer } from "../db/schema.js";
import { embedText } from "../embeddings/gemini.js";

export interface ScoredDrawer extends Drawer {
  score: number;
}

export interface SearchOptions {
  wing?: string;
  hall?: string;
  room?: string;
  limit?: number;
  threshold?: number;
}

/**
 * Semantic vector search using cosine distance.
 * Returns drawers sorted by similarity (closest first).
 */
export async function vectorSearch(
  query: string,
  options: SearchOptions = {}
): Promise<ScoredDrawer[]> {
  const { wing, hall, room, limit = 10, threshold = 0.5 } = options;
  const queryEmbedding = await embedText(query);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  // Build filter conditions using Drizzle's sql template (parameterized)
  const conditions: ReturnType<typeof sql>[] = [];
  if (wing) conditions.push(sql`${drawers.wing} = ${wing}`);
  if (hall) conditions.push(sql`${drawers.hall} = ${hall}`);
  if (room) conditions.push(sql`${drawers.room} = ${room}`);

  const whereClause =
    conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

  const result = await db.execute(sql`
    SELECT *,
      1 - (embedding <=> ${embeddingStr}::vector) as score
    FROM drawers
    ${whereClause}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `);

  return (result.rows as unknown as Array<Drawer & { score: number }>).filter(
    (r) => r.score >= 1 - threshold
  );
}

/**
 * Full-text keyword search using PostgreSQL tsvector/tsquery.
 */
export async function keywordSearch(
  query: string,
  options: SearchOptions = {}
): Promise<ScoredDrawer[]> {
  const { wing, hall, room, limit = 10 } = options;

  const conditions: ReturnType<typeof sql>[] = [
    sql`to_tsvector('english', content) @@ plainto_tsquery('english', ${query})`,
  ];

  if (wing) conditions.push(sql`${drawers.wing} = ${wing}`);
  if (hall) conditions.push(sql`${drawers.hall} = ${hall}`);
  if (room) conditions.push(sql`${drawers.room} = ${room}`);

  const result = await db.execute(sql`
    SELECT *,
      ts_rank(to_tsvector('english', content), plainto_tsquery('english', ${query})) as score
    FROM drawers
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY score DESC
    LIMIT ${limit}
  `);

  return result.rows as unknown as ScoredDrawer[];
}

/**
 * Hybrid search combining vector + keyword results using
 * Reciprocal Rank Fusion (RRF).
 *
 * RRF score = sum(1 / (k + rank_i)) where k=60.
 * This avoids needing to normalize scores between different search methods.
 */
export async function hybridSearch(
  query: string,
  options: SearchOptions = {}
): Promise<ScoredDrawer[]> {
  const limit = options.limit ?? 10;
  const k = 60; // RRF constant

  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearch(query, { ...options, limit: limit * 2 }),
    keywordSearch(query, { ...options, limit: limit * 2 }),
  ]);

  // Build RRF scores
  const rrfScores = new Map<string, { drawer: ScoredDrawer; score: number }>();

  vectorResults.forEach((drawer, rank) => {
    const existing = rrfScores.get(drawer.id) ?? { drawer, score: 0 };
    existing.score += 1 / (k + rank);
    existing.drawer = drawer;
    rrfScores.set(drawer.id, existing);
  });

  keywordResults.forEach((drawer, rank) => {
    const existing = rrfScores.get(drawer.id) ?? { drawer, score: 0 };
    existing.score += 1 / (k + rank);
    if (!rrfScores.has(drawer.id)) {
      existing.drawer = drawer;
    }
    rrfScores.set(drawer.id, existing);
  });

  // Sort by RRF score descending, return top N
  return Array.from(rrfScores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ drawer, score }) => ({ ...drawer, score }));
}

/**
 * Search verified facts by semantic similarity to a claim.
 */
export async function searchVerifiedFacts(
  claim: string,
  options: { limit?: number; maxAgeDays?: number } = {}
): Promise<Array<{ id: string; claim: string; verdict: string; explanation: string; confidence: number; score: number }>> {
  const { limit = 5, maxAgeDays = 30 } = options;
  const queryEmbedding = await embedText(claim);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const result = await db.execute(sql`
    SELECT id, claim, verdict, explanation, confidence,
      1 - (embedding <=> ${embeddingStr}::vector) as score
    FROM verified_facts
    WHERE checked_at > now() - interval '1 day' * ${maxAgeDays}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `);

  return result.rows as Array<{
    id: string;
    claim: string;
    verdict: string;
    explanation: string;
    confidence: number;
    score: number;
  }>;
}
