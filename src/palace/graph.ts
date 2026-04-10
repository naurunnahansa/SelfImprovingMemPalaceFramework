import { eq, and, isNull, sql, lte, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { entities, triples, type Entity, type Triple } from "../db/schema.js";
import { embedText } from "../embeddings/gemini.js";

/**
 * Upsert an entity in the knowledge graph.
 * If an entity with the same name+type exists, updates its attributes.
 */
export async function upsertEntity(
  name: string,
  entityType: string,
  attributes?: Record<string, unknown>
): Promise<Entity> {
  const embedding = await embedText(`${name} (${entityType})`);

  const [row] = await db
    .insert(entities)
    .values({
      name,
      entityType,
      attributes: attributes ?? {},
      embedding,
    })
    .onConflictDoUpdate({
      target: [entities.name, entities.entityType],
      set: {
        attributes: attributes ?? {},
        embedding,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  return row!;
}

/**
 * Find an entity by name and optional type.
 */
export async function findEntity(
  name: string,
  entityType?: string
): Promise<Entity | null> {
  const conditions = entityType
    ? and(eq(entities.name, name), eq(entities.entityType, entityType))
    : eq(entities.name, name);

  const [row] = await db
    .select()
    .from(entities)
    .where(conditions!)
    .limit(1);

  return row ?? null;
}

/**
 * Add a temporal triple to the knowledge graph.
 * If a conflicting current triple exists (same subject+predicate+object, valid_to IS NULL),
 * closes the old one and creates a new one.
 */
export async function addTriple(input: {
  subjectId: string;
  predicate: string;
  objectId?: string;
  objectValue?: string;
  confidence?: number;
  source?: string;
  validFrom?: Date;
}): Promise<Triple> {
  // Close any existing current triple with same subject+predicate
  if (input.objectId) {
    await db
      .update(triples)
      .set({ validTo: sql`now()` })
      .where(
        and(
          eq(triples.subjectId, input.subjectId),
          eq(triples.predicate, input.predicate),
          eq(triples.objectId, input.objectId),
          isNull(triples.validTo)
        )
      );
  } else if (input.objectValue) {
    await db
      .update(triples)
      .set({ validTo: sql`now()` })
      .where(
        and(
          eq(triples.subjectId, input.subjectId),
          eq(triples.predicate, input.predicate),
          eq(triples.objectValue, input.objectValue),
          isNull(triples.validTo)
        )
      );
  }

  const [row] = await db
    .insert(triples)
    .values({
      subjectId: input.subjectId,
      predicate: input.predicate,
      objectId: input.objectId ?? null,
      objectValue: input.objectValue ?? null,
      confidence: input.confidence ?? 1.0,
      source: input.source ?? null,
      validFrom: input.validFrom ?? new Date(),
    })
    .returning();

  return row!;
}

/**
 * Query triples for an entity, optionally filtered by predicate and point-in-time.
 */
export async function queryTriples(
  subjectId: string,
  options: {
    predicate?: string;
    asOf?: Date;
    direction?: "outgoing" | "incoming" | "both";
  } = {}
): Promise<Triple[]> {
  const { predicate, asOf = new Date(), direction = "both" } = options;

  const timeFilter = and(
    lte(triples.validFrom, asOf),
    or(isNull(triples.validTo), sql`${triples.validTo} > ${asOf}`)
  );

  const conditions: Parameters<typeof and> = [timeFilter!];

  if (predicate) {
    conditions.push(eq(triples.predicate, predicate));
  }

  if (direction === "outgoing" || direction === "both") {
    const outgoing = await db
      .select()
      .from(triples)
      .where(and(eq(triples.subjectId, subjectId), ...conditions));

    if (direction === "outgoing") return outgoing;

    const incoming = await db
      .select()
      .from(triples)
      .where(and(eq(triples.objectId, subjectId), ...conditions));

    return [...outgoing, ...incoming];
  }

  // incoming only
  return db
    .select()
    .from(triples)
    .where(and(eq(triples.objectId, subjectId), ...conditions));
}

/**
 * Invalidate a triple by setting its valid_to to now.
 */
export async function invalidateTriple(
  subjectId: string,
  predicate: string,
  objectId?: string,
  objectValue?: string
): Promise<number> {
  const conditions = [
    eq(triples.subjectId, subjectId),
    eq(triples.predicate, predicate),
    isNull(triples.validTo),
  ];

  if (objectId) conditions.push(eq(triples.objectId, objectId));
  if (objectValue) conditions.push(eq(triples.objectValue, objectValue));

  const result = await db
    .update(triples)
    .set({ validTo: sql`now()` })
    .where(and(...conditions))
    .returning();

  return result.length;
}

/**
 * BFS traversal from an entity to find related entities up to N hops.
 */
export async function findRelated(
  entityId: string,
  maxDepth: number = 2
): Promise<Array<{ entity: Entity; depth: number; via: string }>> {
  const visited = new Set<string>([entityId]);
  const results: Array<{ entity: Entity; depth: number; via: string }> = [];
  let frontier = [entityId];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      // Find outgoing connections
      const outgoing = await db
        .select()
        .from(triples)
        .where(and(eq(triples.subjectId, currentId), isNull(triples.validTo)));

      for (const triple of outgoing) {
        if (triple.objectId && !visited.has(triple.objectId)) {
          visited.add(triple.objectId);
          nextFrontier.push(triple.objectId);

          const [entity] = await db
            .select()
            .from(entities)
            .where(eq(entities.id, triple.objectId));

          if (entity) {
            results.push({ entity, depth, via: triple.predicate });
          }
        }
      }

      // Find incoming connections
      const incoming = await db
        .select()
        .from(triples)
        .where(and(eq(triples.objectId, currentId), isNull(triples.validTo)));

      for (const triple of incoming) {
        if (!visited.has(triple.subjectId)) {
          visited.add(triple.subjectId);
          nextFrontier.push(triple.subjectId);

          const [entity] = await db
            .select()
            .from(entities)
            .where(eq(entities.id, triple.subjectId));

          if (entity) {
            results.push({ entity, depth, via: triple.predicate });
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  return results;
}

/**
 * Get a chronological timeline of all triples involving an entity.
 */
export async function timeline(
  entityId: string
): Promise<Triple[]> {
  const outgoing = await db
    .select()
    .from(triples)
    .where(eq(triples.subjectId, entityId))
    .orderBy(triples.validFrom);

  const incoming = await db
    .select()
    .from(triples)
    .where(eq(triples.objectId, entityId))
    .orderBy(triples.validFrom);

  return [...outgoing, ...incoming].sort(
    (a, b) => a.validFrom.getTime() - b.validFrom.getTime()
  );
}
