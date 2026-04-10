import type { ActiveRoom } from "../palace/layers.js";
import type { UserPreference } from "../db/schema.js";
import { buildMemoryContext } from "../palace/layers.js";
import { hybridSearch } from "../palace/search.js";

const BEHAVIOR_RULES = `## Core Behavior Rules

1. NEVER blindly agree with factual claims. If a user states something as fact, verify it before responding.
2. If you're uncertain about something, say so clearly. Use your searchWebTool to verify.
3. When corrected by the user, don't just accept it — research whether the correction is actually right.
4. Store important facts and learnings in the memory palace using storeMemory and storeKnowledge.
5. Adapt your communication style to the user's preferences (see Style section above).
6. When you discover you were wrong, acknowledge it honestly and explain what the correct answer is.
7. For recent events (2025-2026), always verify with a web search — your training data may be outdated.
8. Ask clarifying questions when a claim seems surprising — "Why do you think X?" is better than blindly accepting.`;

/**
 * Build the full dynamic system prompt from memory layers + user preferences.
 */
export async function buildSystemPrompt(
  userId: string,
  activeRooms: ActiveRoom[],
  currentMessage: string,
  preferences: UserPreference[],
  corrections?: string[]
): Promise<string> {
  const memory = await buildMemoryContext(userId, activeRooms, currentMessage);

  const sections: string[] = [];

  // Identity + role
  sections.push(
    `You are a memory-augmented AI assistant with persistent memory. You verify facts, remember context across conversations, and adapt to each user's communication style.`
  );

  // User preferences
  if (preferences.length > 0) {
    const prefLines = preferences.map(
      (p) => `- ${p.category}/${p.key}: ${p.value} (confidence: ${p.confidence.toFixed(2)})`
    );
    sections.push(`## User Preferences\n${prefLines.join("\n")}`);
  }

  // Behavior rules
  sections.push(BEHAVIOR_RULES);

  // Memory context (L0 through L3)
  if (memory.fullContext) {
    sections.push(
      `## Memory (${memory.totalTokens} tokens loaded)\n${memory.fullContext}`
    );
  }

  // Load relevant past learnings (corrections + good patterns) for active topics
  const activeRoomNames = activeRooms.map((r) => r.room);
  if (activeRoomNames.length > 0) {
    try {
      const learnings = await hybridSearch(
        `corrections learnings patterns ${activeRoomNames.join(" ")}`,
        { hall: "learnings", limit: 5 }
      );
      const corrections_from_past = await hybridSearch(
        `correction ${currentMessage}`,
        { hall: "corrections", limit: 3 }
      );
      const allLearnings = [...learnings, ...corrections_from_past];

      if (allLearnings.length > 0) {
        const learningLines = allLearnings
          .map((l) => `- [${l.wing}/${l.room}] ${l.content.slice(0, 300)}`)
          .join("\n");
        sections.push(
          `## Past Learnings (from feedback)\n${learningLines}`
        );
      }
    } catch {
      // Learnings loading is best-effort
    }
  }

  // Fact-check corrections for this turn
  if (corrections && corrections.length > 0) {
    sections.push(
      `## Fact Check Results\nThe following claims from the user's message were verified:\n${corrections.join("\n")}\n\nYou MUST address these in your response. If a claim was refuted, politely correct the user with evidence.`
    );
  }

  return sections.join("\n\n");
}
