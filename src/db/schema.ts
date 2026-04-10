import {
  pgTable,
  text,
  uuid,
  integer,
  real,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core/columns/vector_extension/vector";
import { sql } from "drizzle-orm";

// ─── Drawers ─────────────────────────────────────────────────────────────────
// Core memory storage. Each drawer is a content chunk tagged with its
// spatial location in the palace (wing/hall/room).

export const drawers = pgTable(
  "drawers",
  {
    id: uuid().defaultRandom().primaryKey(),
    wing: text().notNull(),
    hall: text().notNull(),
    room: text().notNull(),
    content: text().notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector({ dimensions: 3072 }),
    metadata: jsonb().$type<Record<string, unknown>>(),
    tokenCount: integer("token_count").notNull(),
    source: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).defaultNow().notNull(),
    accessCount: integer("access_count").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("drawers_content_hash_idx").on(table.contentHash),
    index("drawers_wing_hall_room_idx").on(table.wing, table.hall, table.room),
    index("drawers_wing_idx").on(table.wing),
    index("drawers_room_idx").on(table.room),
  ]
);

// ─── Entities ────────────────────────────────────────────────────────────────
// Knowledge graph nodes: people, projects, concepts, places, etc.

export const entities = pgTable(
  "entities",
  {
    id: uuid().defaultRandom().primaryKey(),
    name: text().notNull(),
    entityType: text("entity_type").notNull(),
    attributes: jsonb().$type<Record<string, unknown>>().default({}),
    embedding: vector({ dimensions: 3072 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("entities_name_type_idx").on(table.name, table.entityType),
  ]
);

// ─── Triples ─────────────────────────────────────────────────────────────────
// RDF-style temporal relationships between entities.
// Every fact has valid_from/valid_to for temporal queries.

export const triples = pgTable(
  "triples",
  {
    id: uuid().defaultRandom().primaryKey(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => entities.id),
    predicate: text().notNull(),
    objectId: uuid("object_id").references(() => entities.id),
    objectValue: text("object_value"),
    confidence: real().default(1.0).notNull(),
    source: text(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("triples_subject_predicate_idx").on(table.subjectId, table.predicate),
    index("triples_object_idx").on(table.objectId),
    index("triples_current_idx")
      .on(table.subjectId, table.predicate)
      .where(sql`${table.validTo} IS NULL`),
  ]
);

// ─── Verified Facts ──────────────────────────────────────────────────────────
// Fact-checked claims with provenance and confidence.

export const verifiedFacts = pgTable(
  "verified_facts",
  {
    id: uuid().defaultRandom().primaryKey(),
    claim: text().notNull(),
    verdict: text().notNull(), // "confirmed" | "refuted" | "partially_true" | "unverifiable"
    explanation: text().notNull(),
    sources: jsonb().$type<
      Array<{ url: string; title: string; snippet: string }>
    >(),
    confidence: real().notNull(),
    embedding: vector({ dimensions: 3072 }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
  },
  () => []
);

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey(),
    externalId: text("external_id"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("users_external_id_idx").on(table.externalId)]
);

// ─── User Preferences ───────────────────────────────────────────────────────
// Learned preferences: communication style, expertise, pet peeves, etc.

export const userPreferences = pgTable(
  "user_preferences",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    category: text().notNull(), // "communication", "expertise", "style", "content"
    key: text().notNull(), // "verbosity", "emoji_usage", "expertise_level"
    value: text().notNull(), // "concise", "heavy", "expert"
    confidence: real().default(0.5).notNull(),
    learnedFrom: text("learned_from"), // "explicit", "implicit", "thumbs_down"
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_prefs_unique_idx").on(
      table.userId,
      table.category,
      table.key
    ),
  ]
);

// ─── Feedback ────────────────────────────────────────────────────────────────
// Thumbs-down and correction records with agent self-reflection.

export const feedback = pgTable(
  "feedback",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id),
    conversationId: uuid("conversation_id"),
    messageId: uuid("message_id"),
    feedbackType: text("feedback_type").notNull(), // "thumbs_down", "correction", "explicit"
    originalResponse: text("original_response"),
    userCorrection: text("user_correction"),
    analysis: text(), // Agent's self-reflection
    errorCategory: text("error_category"), // "factual", "style", "missed_context", "hallucination"
    resolution: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  () => []
);

// ─── Conversations ──────────────────────────────────────────────────────────

export const conversations = pgTable(
  "conversations",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id),
    title: text(),
    topicTags: jsonb("topic_tags").$type<string[]>().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  () => []
);

// ─── Messages ────────────────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: uuid().defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text().notNull(), // "user", "assistant", "system", "tool"
    content: text().notNull(),
    embedding: vector({ dimensions: 3072 }),
    topicTags: jsonb("topic_tags").$type<string[]>().default([]),
    tokenCount: integer("token_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("messages_conversation_idx").on(
      table.conversationId,
      table.createdAt
    ),
  ]
);

// ─── Types ───────────────────────────────────────────────────────────────────

export type Drawer = typeof drawers.$inferSelect;
export type NewDrawer = typeof drawers.$inferInsert;
export type Entity = typeof entities.$inferSelect;
export type Triple = typeof triples.$inferSelect;
export type VerifiedFact = typeof verifiedFacts.$inferSelect;
export type User = typeof users.$inferSelect;
export type UserPreference = typeof userPreferences.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
