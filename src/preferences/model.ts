import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { userPreferences, type UserPreference } from "../db/schema.js";

/**
 * Get all preferences for a user, optionally filtered by category.
 */
export async function getPreferences(
  userId: string,
  category?: string
): Promise<UserPreference[]> {
  const conditions = category
    ? and(
        eq(userPreferences.userId, userId),
        eq(userPreferences.category, category)
      )
    : eq(userPreferences.userId, userId);

  return db
    .select()
    .from(userPreferences)
    .where(conditions!);
}

/**
 * Upsert a user preference. If it already exists, update with confidence blending.
 */
export async function upsertPreference(input: {
  userId: string;
  category: string;
  key: string;
  value: string;
  confidence?: number;
  learnedFrom?: string;
}): Promise<UserPreference> {
  const confidence = input.confidence ?? 0.5;

  const [row] = await db
    .insert(userPreferences)
    .values({
      userId: input.userId,
      category: input.category,
      key: input.key,
      value: input.value,
      confidence,
      learnedFrom: input.learnedFrom ?? "implicit",
    })
    .onConflictDoUpdate({
      target: [
        userPreferences.userId,
        userPreferences.category,
        userPreferences.key,
      ],
      set: {
        value: input.value,
        // Blend confidence: new = old * 0.7 + signal * 0.3
        confidence: sql`LEAST(1.0, ${userPreferences.confidence} * 0.7 + ${confidence} * 0.3)`,
        learnedFrom: input.learnedFrom ?? "implicit",
        updatedAt: sql`now()`,
      },
    })
    .returning();

  return row!;
}
