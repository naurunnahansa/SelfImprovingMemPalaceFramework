import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { drawers, userPreferences } from "../db/schema.js";
import { hybridSearch } from "./search.js";

// ─── Token Budgets ───────────────────────────────────────────────────────────

const L0_BUDGET = 100;
const L1_BUDGET = 800;
const L2_BUDGET = 2000;
const L3_BUDGET = 1000;
const TOTAL_BUDGET = L0_BUDGET + L1_BUDGET + L2_BUDGET + L3_BUDGET;

export interface LayerContent {
  layer: "L0" | "L1" | "L2" | "L3";
  content: string;
  tokenCount: number;
  drawerIds: string[];
}

export interface ActiveRoom {
  wing: string;
  hall: string;
  room: string;
  relevance: number;
  tokenCount: number;
}

// ─── L0: Identity ────────────────────────────────────────────────────────────
// Core identity + user basics. Always loaded. ~100 tokens.

export async function loadL0(userId: string): Promise<LayerContent> {
  // Load identity drawers
  const identityRows = await db
    .select()
    .from(drawers)
    .where(sql`${drawers.wing} = 'system' AND ${drawers.hall} = 'identity'`)
    .limit(5);

  // Load user preferences summary
  const prefs = await db
    .select()
    .from(userPreferences)
    .where(sql`${userPreferences.userId} = ${userId} AND ${userPreferences.confidence} > 0.6`);

  let content = "";
  const ids: string[] = [];
  let tokens = 0;

  if (identityRows.length > 0) {
    for (const row of identityRows) {
      if (tokens + row.tokenCount > L0_BUDGET) break;
      content += row.content + "\n";
      tokens += row.tokenCount;
      ids.push(row.id);
    }
  }

  if (prefs.length > 0) {
    const prefSummary = prefs
      .map((p) => `${p.key}: ${p.value}`)
      .join(", ");
    const prefLine = `User preferences: ${prefSummary}`;
    const prefTokens = Math.ceil(prefLine.length / 4);
    if (tokens + prefTokens <= L0_BUDGET) {
      content += prefLine + "\n";
      tokens += prefTokens;
    }
  }

  return { layer: "L0", content: content.trim(), tokenCount: tokens, drawerIds: ids };
}

// ─── L1: Essential Story ─────────────────────────────────────────────────────
// Top memories by access frequency * recency. Always loaded. ~800 tokens.

export async function loadL1(userId?: string): Promise<LayerContent> {
  // Score: access_count / (1 + days_since_access * 0.1)
  const rows = await db.execute(sql`
    SELECT *,
      access_count::float / (1 + EXTRACT(EPOCH FROM (now() - accessed_at)) / 86400 * 0.1) as recency_score
    FROM drawers
    WHERE wing != 'system'
    ORDER BY recency_score DESC
    LIMIT 30
  `);

  let content = "";
  let tokens = 0;
  const ids: string[] = [];
  const roomGroups = new Map<string, string[]>();

  for (const row of rows.rows as Array<Record<string, unknown>>) {
    const tc = row.token_count as number;
    if (tokens + tc > L1_BUDGET) continue;

    const roomKey = `${row.wing}/${row.room}`;
    if (!roomGroups.has(roomKey)) {
      roomGroups.set(roomKey, []);
    }

    const snippet =
      (row.content as string).length > 200
        ? (row.content as string).slice(0, 200) + "..."
        : (row.content as string);

    roomGroups.get(roomKey)!.push(snippet);
    tokens += tc;
    ids.push(row.id as string);
  }

  for (const [roomKey, snippets] of roomGroups) {
    content += `[${roomKey}]\n`;
    for (const s of snippets) {
      content += `- ${s}\n`;
    }
    content += "\n";
  }

  return { layer: "L1", content: content.trim(), tokenCount: tokens, drawerIds: ids };
}

// ─── L2: Active Context ──────────────────────────────────────────────────────
// Drawers from rooms the context machine has marked as active. ~2000 tokens.

export async function loadL2(activeRooms: ActiveRoom[]): Promise<LayerContent> {
  if (activeRooms.length === 0) {
    return { layer: "L2", content: "", tokenCount: 0, drawerIds: [] };
  }

  // Sort rooms by relevance descending — load highest-relevance rooms first
  const sorted = [...activeRooms].sort((a, b) => b.relevance - a.relevance);

  let content = "";
  let tokens = 0;
  const ids: string[] = [];

  for (const room of sorted) {
    if (tokens >= L2_BUDGET) break;

    const roomDrawers = await db
      .select()
      .from(drawers)
      .where(
        sql`${drawers.wing} = ${room.wing} AND ${drawers.room} = ${room.room}`
      )
      .orderBy(sql`${drawers.accessCount} DESC`)
      .limit(10);

    if (roomDrawers.length === 0) continue;

    content += `[${room.wing}/${room.room}] (relevance: ${room.relevance.toFixed(2)})\n`;

    for (const drawer of roomDrawers) {
      if (tokens + drawer.tokenCount > L2_BUDGET) break;
      content += `- ${drawer.content}\n`;
      tokens += drawer.tokenCount;
      ids.push(drawer.id);
    }

    content += "\n";
  }

  return { layer: "L2", content: content.trim(), tokenCount: tokens, drawerIds: ids };
}

// ─── L3: Deep Search ─────────────────────────────────────────────────────────
// Semantic search on current message, excluding already-loaded IDs. ~1000 tokens.

export async function loadL3(
  query: string,
  excludeIds: string[]
): Promise<LayerContent> {
  const results = await hybridSearch(query, { limit: 15 });

  // Filter out already-loaded drawers
  const excludeSet = new Set(excludeIds);
  const filtered = results.filter((r) => !excludeSet.has(r.id));

  let content = "";
  let tokens = 0;
  const ids: string[] = [];

  for (const drawer of filtered) {
    if (tokens + drawer.tokenCount > L3_BUDGET) break;
    content += `- [${drawer.wing}/${drawer.room}] ${drawer.content}\n`;
    tokens += drawer.tokenCount;
    ids.push(drawer.id);
  }

  return { layer: "L3", content: content.trim(), tokenCount: tokens, drawerIds: ids };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function buildMemoryContext(
  userId: string,
  activeRooms: ActiveRoom[],
  currentQuery: string
): Promise<{ fullContext: string; totalTokens: number; layers: LayerContent[] }> {
  const l0 = await loadL0(userId);
  const l1 = await loadL1(userId);
  const l2 = await loadL2(activeRooms);

  // Collect all IDs loaded so far for L3 exclusion
  const loadedIds = [...l0.drawerIds, ...l1.drawerIds, ...l2.drawerIds];
  const l3 = await loadL3(currentQuery, loadedIds);

  const layers = [l0, l1, l2, l3];
  const totalTokens = layers.reduce((sum, l) => sum + l.tokenCount, 0);

  const sections: string[] = [];

  if (l0.content) {
    sections.push(`## Identity\n${l0.content}`);
  }
  if (l1.content) {
    sections.push(`## Key Memories\n${l1.content}`);
  }
  if (l2.content) {
    sections.push(`## Active Context\n${l2.content}`);
  }
  if (l3.content) {
    sections.push(`## Related Memories\n${l3.content}`);
  }

  return {
    fullContext: sections.join("\n\n"),
    totalTokens,
    layers,
  };
}
