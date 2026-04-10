import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../config.js";
import { upsertPreference } from "./model.js";

const preferenceSignalSchema = z.object({
  signals: z.array(
    z.object({
      category: z.enum(["communication", "expertise", "style", "content"]),
      key: z.string().describe("Preference key, e.g. 'verbosity', 'emoji_usage'"),
      value: z.string().describe("Detected value, e.g. 'concise', 'none'"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe("How confident is this detection"),
      source: z.enum(["implicit", "explicit"]),
    })
  ),
});

/**
 * Passively detect user preferences from a message exchange.
 * Runs in the background after each turn — does NOT block the response.
 */
export async function detectPreferences(
  userId: string,
  userMessage: string,
  agentResponse: string
): Promise<void> {
  try {
    const { object } = await generateObject({
      model: getModel("fast"),
      schema: preferenceSignalSchema,
      prompt: `Analyze this exchange between a user and an AI assistant. Detect any signals about the user's communication preferences.

User message:
"${userMessage}"

AI response:
"${agentResponse}"

Look for signals like:
- Verbosity preference: Does the user write short messages? Did they ask to "be brief" or "explain more"?
- Emoji usage: Does the user use emojis? (If yes, the AI can mirror. If no, avoid emojis.)
- Expertise level: Does the user use technical jargon? Ask beginner questions?
- Tone: Formal or casual? Uses humor?
- Format preference: Asks for lists? Code blocks? Bullet points?

Only report signals you're reasonably confident about. Return an empty array if no clear signals.`,
    });

    // Store detected preferences
    for (const signal of object.signals) {
      await upsertPreference({
        userId,
        category: signal.category,
        key: signal.key,
        value: signal.value,
        confidence: signal.confidence,
        learnedFrom: signal.source,
      });
    }
  } catch {
    // Silent failure — preference detection is best-effort
  }
}
