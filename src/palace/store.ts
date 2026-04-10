import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { drawers, type Drawer, type NewDrawer } from "../db/schema.js";
import { embedText, estimateTokens } from "../embeddings/gemini.js";

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface StoreDrawerInput {
  wing: string;
  hall: string;
  room: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Store a drawer in the palace. Idempotent — duplicate content
 * (by SHA-256 hash) updates accessed_at instead of creating a new row.
 */
export async function storeDrawer(input: StoreDrawerInput): Promise<Drawer> {
  const hash = contentHash(input.content);
  const embedding = await embedText(input.content);
  const tokenCount = estimateTokens(input.content);

  const [row] = await db
    .insert(drawers)
    .values({
      wing: input.wing,
      hall: input.hall,
      room: input.room,
      content: input.content,
      contentHash: hash,
      embedding,
      metadata: input.metadata ?? {},
      tokenCount,
      source: input.source ?? null,
    })
    .onConflictDoUpdate({
      target: drawers.contentHash,
      set: {
        accessedAt: sql`now()`,
        accessCount: sql`${drawers.accessCount} + 1`,
      },
    })
    .returning();

  return row!;
}

/**
 * Retrieve a drawer by ID. Bumps access tracking.
 */
export async function getDrawer(id: string): Promise<Drawer | null> {
  const [row] = await db
    .update(drawers)
    .set({
      accessedAt: sql`now()`,
      accessCount: sql`${drawers.accessCount} + 1`,
    })
    .where(eq(drawers.id, id))
    .returning();

  return row ?? null;
}

/**
 * Get all drawers in a specific room, ordered by access count descending.
 */
export async function getRoom(
  wing: string,
  hall: string,
  room: string
): Promise<Drawer[]> {
  return db
    .select()
    .from(drawers)
    .where(
      sql`${drawers.wing} = ${wing} AND ${drawers.hall} = ${hall} AND ${drawers.room} = ${room}`
    )
    .orderBy(sql`${drawers.accessCount} DESC`);
}

/**
 * Get all drawers in a wing (across all halls/rooms).
 */
export async function getWing(wing: string): Promise<Drawer[]> {
  return db
    .select()
    .from(drawers)
    .where(eq(drawers.wing, wing))
    .orderBy(sql`${drawers.accessCount} DESC`);
}

/**
 * List all distinct wings in the palace.
 */
export async function listWings(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ wing: drawers.wing })
    .from(drawers);
  return rows.map((r) => r.wing);
}

/**
 * List all distinct rooms, optionally filtered by wing.
 */
export async function listRooms(
  wing?: string
): Promise<Array<{ wing: string; hall: string; room: string; count: number }>> {
  const query = wing
    ? sql`SELECT wing, hall, room, COUNT(*)::int as count FROM drawers WHERE wing = ${wing} GROUP BY wing, hall, room ORDER BY count DESC`
    : sql`SELECT wing, hall, room, COUNT(*)::int as count FROM drawers GROUP BY wing, hall, room ORDER BY count DESC`;

  const rows = await db.execute(query);
  return rows.rows as Array<{
    wing: string;
    hall: string;
    room: string;
    count: number;
  }>;
}

/**
 * Delete a drawer by ID.
 */
export async function deleteDrawer(id: string): Promise<boolean> {
  const result = await db.delete(drawers).where(eq(drawers.id, id)).returning();
  return result.length > 0;
}
