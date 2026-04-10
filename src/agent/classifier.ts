import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../config.js";

const classificationSchema = z.object({
  topics: z
    .array(
      z.object({
        wing: z.string().describe("Category: 'user:{name}', 'project:{name}', 'system', or general category"),
        room: z.string().describe("Specific topic slug, e.g. 'typescript', 'cooking', 'career'"),
      })
    )
    .describe("Topics mentioned or implied in the message"),
  claims: z
    .array(
      z.object({
        text: z.string().describe("The factual claim extracted from the message"),
        type: z.enum(["factual", "opinion", "preference", "question"]),
      })
    )
    .describe("Any claims, assertions, or statements of fact in the message"),
  intent: z.enum(["question", "statement", "command", "feedback", "greeting", "chitchat"]),
  sentiment: z.enum(["positive", "neutral", "negative", "correction"]),
});

export type MessageClassification = z.infer<typeof classificationSchema>;

/**
 * Classify a user message in a single fast LLM call.
 * Extracts topics, factual claims, intent, and sentiment.
 */
export async function classifyMessage(
  message: string
): Promise<MessageClassification> {
  const { object } = await generateObject({
    model: getModel("fast"),
    schema: classificationSchema,
    prompt: `Analyze this user message and extract structured information.

For topics: identify what subjects the user is talking about. Use lowercase slugs for room names.
For claims: extract any factual assertions the user makes. Mark opinions as "opinion", preferences as "preference", questions as "question", and factual statements as "factual". Only mark something as "factual" if it's a verifiable claim about the real world.
For intent: classify the overall purpose of the message.
For sentiment: "correction" means the user is correcting or disagreeing with something.

User message: "${message}"`,
  });

  return object;
}
