import { setup, assign, fromPromise } from "xstate";
import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../config.js";
import { searchWeb, type ExaResult } from "../search/exa.js";
import { db } from "../db/client.js";
import { feedback, userPreferences, verifiedFacts } from "../db/schema.js";
import { embedText } from "../embeddings/gemini.js";
import { storeDrawer } from "../palace/store.js";
import { sql } from "drizzle-orm";

// ─── Types ───────────────────────────────────────────────────────────────────

type ErrorCategory =
  | "factual_error"
  | "style_mismatch"
  | "missed_context"
  | "hallucination"
  | "outdated_info"
  | "misunderstood_question";

type PositiveCategory =
  | "accurate_facts"
  | "good_style"
  | "helpful_depth"
  | "good_conciseness"
  | "effective_correction";

interface FeedbackContext {
  feedbackType: "good" | "bad" | "correction";
  originalMessage: string;
  originalResponse: string;
  userCorrection: string | null;
  conversationId: string;
  messageId: string;
  userId: string;
  // Negative analysis
  errorAnalysis: {
    errorCategory: ErrorCategory;
    explanation: string;
    topicWing: string;
    topicRoom: string;
    affectedEntities: string[];
    suggestedPreferenceUpdates: Array<{
      category: string;
      key: string;
      value: string;
    }>;
  } | null;
  // Positive analysis
  positiveAnalysis: {
    positiveCategory: PositiveCategory;
    whatWorked: string;
    topicWing: string;
    topicRoom: string;
    patternsToRepeat: string[];
    suggestedPreferenceUpdates: Array<{
      category: string;
      key: string;
      value: string;
    }>;
  } | null;
  researchResults: ExaResult[];
  resolution: string | null;
}

// ─── Actors ──────────────────────────────────────────────────────────────────

// Analyze what went WRONG
const analyzeErrorActor = fromPromise(
  async ({
    input,
  }: {
    input: {
      originalMessage: string;
      originalResponse: string;
      userCorrection: string | null;
      feedbackType: string;
    };
  }) => {
    const { object } = await generateObject({
      model: getModel("main"),
      schema: z.object({
        errorCategory: z.enum([
          "factual_error",
          "style_mismatch",
          "missed_context",
          "hallucination",
          "outdated_info",
          "misunderstood_question",
        ]),
        explanation: z.string().describe("What went wrong and why"),
        topicWing: z
          .string()
          .describe("Which wing this error belongs to — e.g., 'project:typescript', 'general', 'user:alice'. Use the most specific category that fits."),
        topicRoom: z
          .string()
          .describe("Which room/topic this error belongs to — e.g., 'type-safety', 'speed-of-light', 'api-design'. Use a lowercase slug."),
        affectedEntities: z
          .array(z.string())
          .describe("Any specific entities (people, tools, concepts) that need their knowledge graph entries updated"),
        suggestedPreferenceUpdates: z
          .array(
            z.object({
              category: z.string(),
              key: z.string(),
              value: z.string(),
            })
          )
          .describe("User preference updates if this was a style issue"),
      }),
      prompt: `A user gave negative feedback (/bad) on an AI response. Analyze what went wrong.

${input.userCorrection ? `User's correction: "${input.userCorrection}"` : "No correction provided — just a /bad signal."}

User's original message:
"${input.originalMessage}"

AI's response:
"${input.originalResponse}"

Classify the error:
- factual_error: The AI stated something false as fact
- style_mismatch: Tone, verbosity, emoji usage, or format was wrong for this user
- missed_context: The AI missed something important from the conversation
- hallucination: The AI made something up entirely
- outdated_info: The AI used old/expired information
- misunderstood_question: The AI answered a different question than asked

IMPORTANT: Also identify which topic/domain this error belongs to:
- topicWing: the broad category (e.g., "project:typescript", "general:science", "general:history")
- topicRoom: the specific topic slug (e.g., "type-system", "speed-of-light", "world-war-2")
- affectedEntities: any named entities whose knowledge needs updating (e.g., "TypeScript", "OpenAI", "speed of light")

This determines WHERE the correction gets stored in the memory palace so it's findable in future conversations about the same topic.`,
    });
    return object;
  }
);

// Analyze what went RIGHT
const analyzePositiveActor = fromPromise(
  async ({
    input,
  }: {
    input: {
      originalMessage: string;
      originalResponse: string;
    };
  }) => {
    const { object } = await generateObject({
      model: getModel("fast"),
      schema: z.object({
        positiveCategory: z.enum([
          "accurate_facts",
          "good_style",
          "helpful_depth",
          "good_conciseness",
          "effective_correction",
        ]),
        whatWorked: z
          .string()
          .describe("Specific description of what the user liked about this response"),
        topicWing: z
          .string()
          .describe("Which wing this pattern applies to — e.g., 'general:coding', 'project:typescript', or 'system' for universal patterns"),
        topicRoom: z
          .string()
          .describe("Which room/topic — e.g., 'api-design', 'explanations', 'debugging'. Use 'general' for patterns that apply everywhere."),
        patternsToRepeat: z
          .array(z.string())
          .describe("Concrete patterns to repeat in future responses (e.g., 'used bullet points for comparisons', 'cited specific sources', 'kept answer under 3 sentences')"),
        suggestedPreferenceUpdates: z
          .array(
            z.object({
              category: z.string(),
              key: z.string(),
              value: z.string(),
            })
          )
          .describe("User preference signals confirmed by this positive feedback"),
      }),
      prompt: `A user gave positive feedback (/good) on an AI response. Analyze what worked well so we can repeat it.

User's original message:
"${input.originalMessage}"

AI's response the user liked:
"${input.originalResponse}"

Identify:
1. What category of success this was (accurate facts, good style, helpful depth, good conciseness, effective correction of a misconception)
2. Specifically what worked — be concrete (e.g., "used a table format", "gave a direct yes/no before explaining", "cited 3 sources")
3. Patterns to repeat in future responses — actionable rules (e.g., "for comparison questions, use bullet points", "when correcting myths, lead with the truth then explain the misconception")
4. Any user preferences this confirms (e.g., if the response was concise and got /good, that confirms they prefer concise answers)`,
    });
    return object;
  }
);

// Research to ground corrections
const researchActor = fromPromise(
  async ({ input }: { input: { query: string } }) => {
    return searchWeb(input.query, { numResults: 5 });
  }
);

// Self-reflect and generate corrected answer
const reflectActor = fromPromise(
  async ({
    input,
  }: {
    input: {
      originalMessage: string;
      originalResponse: string;
      errorAnalysis: { errorCategory: string; explanation: string };
      researchResults: ExaResult[];
    };
  }) => {
    const evidence = input.researchResults
      .map((r) => `${r.title}: ${r.highlights.join(" ")}`)
      .join("\n");

    const { object } = await generateObject({
      model: getModel("main"),
      schema: z.object({
        correctedAnswer: z
          .string()
          .describe("What the correct response should have been"),
        rootCause: z
          .string()
          .describe("Root cause of why we got it wrong — be specific so we can avoid it"),
        avoidanceRule: z
          .string()
          .describe("A concrete rule to follow to avoid this mistake in the future"),
      }),
      prompt: `The AI gave a response that received negative feedback. Generate the corrected answer and a rule to avoid this mistake.

Error type: ${input.errorAnalysis.errorCategory}
Analysis: ${input.errorAnalysis.explanation}

User's question:
"${input.originalMessage}"

Original (bad) response:
"${input.originalResponse}"

Research results:
${evidence || "No research results available."}

Provide:
1. What the correct response should have been
2. The root cause (why did the AI get this wrong?)
3. A concrete avoidance rule (e.g., "Always verify year-specific claims with a web search", "Don't assume user wants verbose answers unless asked")`,
    });
    return object;
  }
);

// Store preferences (positive or negative signals)
const storePreferencesActor = fromPromise(
  async ({
    input,
  }: {
    input: {
      userId: string;
      updates: Array<{ category: string; key: string; value: string }>;
      source: "good" | "bad" | "correction";
    };
  }) => {
    for (const update of input.updates) {
      await db
        .insert(userPreferences)
        .values({
          userId: input.userId,
          category: update.category,
          key: update.key,
          value: update.value,
          confidence: input.source === "good" ? 0.9 : 0.8, // Positive feedback = higher confidence
          learnedFrom: input.source,
        })
        .onConflictDoUpdate({
          target: [
            userPreferences.userId,
            userPreferences.category,
            userPreferences.key,
          ],
          set: {
            value: update.value,
            confidence:
              input.source === "good"
                ? sql`LEAST(1.0, ${userPreferences.confidence} * 0.7 + 0.27)` // Boost toward 1.0
                : sql`LEAST(1.0, ${userPreferences.confidence} * 0.7 + 0.24)`,
            learnedFrom: input.source,
            updatedAt: sql`now()`,
          },
        });
    }
    return input.updates;
  }
);

// Store the full feedback record + learnings in the palace
const storeFeedbackActor = fromPromise(
  async ({ input }: { input: { context: FeedbackContext } }) => {
    const ctx = input.context;

    // Store feedback record in DB
    await db.insert(feedback).values({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      feedbackType: ctx.feedbackType,
      originalResponse: ctx.originalResponse,
      userCorrection: ctx.userCorrection,
      analysis:
        ctx.feedbackType === "good"
          ? ctx.positiveAnalysis?.whatWorked ?? null
          : ctx.errorAnalysis?.explanation ?? null,
      errorCategory:
        ctx.feedbackType === "good"
          ? ctx.positiveAnalysis?.positiveCategory ?? null
          : ctx.errorAnalysis?.errorCategory ?? null,
      resolution: ctx.resolution,
    });

    if (ctx.feedbackType === "good" && ctx.positiveAnalysis) {
      const pa = ctx.positiveAnalysis;
      const patterns = pa.patternsToRepeat;

      // Store in the TOPIC-SPECIFIC room so it's loaded when that topic comes up
      if (patterns.length > 0) {
        await storeDrawer({
          wing: pa.topicWing || "system",
          hall: "learnings",
          room: pa.topicRoom || "good_patterns",
          content: `[GOOD PATTERN] ${pa.positiveCategory}\nWhat worked: ${pa.whatWorked}\nPatterns to repeat:\n${patterns.map((p) => `- ${p}`).join("\n")}\n\nOriginal question: ${ctx.originalMessage.slice(0, 200)}\nResponse that worked: ${ctx.originalResponse.slice(0, 300)}`,
          source: "feedback:good",
        });
      }

      // Also store universal patterns in system room for cross-topic learning
      const universalPatterns = patterns.filter(
        (p) =>
          p.toLowerCase().includes("always") ||
          p.toLowerCase().includes("format") ||
          p.toLowerCase().includes("style") ||
          pa.topicRoom === "general"
      );
      if (universalPatterns.length > 0 && pa.topicRoom !== "general") {
        await storeDrawer({
          wing: "system",
          hall: "learnings",
          room: "universal_patterns",
          content: `[UNIVERSAL PATTERN] From ${pa.topicWing}/${pa.topicRoom}: ${universalPatterns.join("; ")}`,
          source: "feedback:good",
        });
      }
    } else if (ctx.feedbackType !== "good" && ctx.errorAnalysis) {
      const ea = ctx.errorAnalysis;

      if (ctx.resolution) {
        // Store corrected fact in verified_facts
        const embedding = await embedText(ctx.resolution);
        await db.insert(verifiedFacts).values({
          claim: ctx.originalResponse.slice(0, 500),
          verdict: "refuted",
          explanation: ctx.resolution,
          sources: ctx.researchResults.map((r) => ({
            url: r.url,
            title: r.title,
            snippet: r.highlights[0] ?? "",
          })),
          confidence: 0.9,
          embedding,
        });
      }

      // Store correction in the TOPIC-SPECIFIC room
      await storeDrawer({
        wing: ea.topicWing || "system",
        hall: "corrections",
        room: ea.topicRoom || "general",
        content: `[CORRECTION] ${ea.errorCategory}\nTopic: ${ea.topicWing}/${ea.topicRoom}\nWhat went wrong: ${ea.explanation}${ctx.resolution ? `\nCorrect answer: ${ctx.resolution}` : ""}\n\nOriginal question: ${ctx.originalMessage.slice(0, 200)}`,
        source: "feedback:bad",
      });

      // Update knowledge graph for affected entities
      if (ea.affectedEntities.length > 0 && ctx.resolution) {
        for (const entityName of ea.affectedEntities) {
          try {
            const entity = await import("../palace/graph.js").then((g) =>
              g.findEntity(entityName)
            );
            if (entity) {
              // Add a correction triple to the entity
              await import("../palace/graph.js").then((g) =>
                g.addTriple({
                  subjectId: entity.id,
                  predicate: "has_correction",
                  objectValue: `${ea.errorCategory}: ${ctx.resolution?.slice(0, 300)}`,
                  source: "feedback:bad",
                })
              );
            }
          } catch {
            // Entity doesn't exist yet — that's fine
          }
        }
      }
    }

    return ctx.resolution;
  }
);

// ─── Machine ─────────────────────────────────────────────────────────────────

export const feedbackMachine = setup({
  types: {
    context: {} as FeedbackContext,
    input: {} as {
      feedbackType: "good" | "bad" | "correction";
      originalMessage: string;
      originalResponse: string;
      userCorrection: string | null;
      conversationId: string;
      messageId: string;
      userId: string;
    },
    output: {} as {
      resolution: string | null;
      errorCategory: string | null;
      positiveCategory: string | null;
      patternsLearned: string[];
    },
  },
  actors: {
    analyzeError: analyzeErrorActor,
    analyzePositive: analyzePositiveActor,
    research: researchActor,
    reflect: reflectActor,
    storePreferences: storePreferencesActor,
    storeFeedback: storeFeedbackActor,
  },
}).createMachine({
  id: "feedbackHandler",
  initial: "routing",
  context: ({ input }) => ({
    ...input,
    errorAnalysis: null,
    positiveAnalysis: null,
    researchResults: [],
    resolution: null,
  }),

  states: {
    // Route based on feedback type
    routing: {
      always: [
        {
          guard: ({ context }) => context.feedbackType === "good",
          target: "analyzingPositive",
        },
        { target: "analyzingError" },
      ],
    },

    // ─── Positive Path ────────────────────────────────────────────
    analyzingPositive: {
      invoke: {
        src: "analyzePositive",
        input: ({ context }) => ({
          originalMessage: context.originalMessage,
          originalResponse: context.originalResponse,
        }),
        onDone: {
          target: "storingPositivePreferences",
          actions: assign({ positiveAnalysis: ({ event }) => event.output }),
        },
        onError: { target: "storing" },
      },
    },

    storingPositivePreferences: {
      invoke: {
        src: "storePreferences",
        input: ({ context }) => ({
          userId: context.userId,
          updates: context.positiveAnalysis?.suggestedPreferenceUpdates ?? [],
          source: "good" as const,
        }),
        onDone: { target: "storing" },
        onError: { target: "storing" },
      },
    },

    // ─── Negative Path ────────────────────────────────────────────
    analyzingError: {
      invoke: {
        src: "analyzeError",
        input: ({ context }) => ({
          originalMessage: context.originalMessage,
          originalResponse: context.originalResponse,
          userCorrection: context.userCorrection,
          feedbackType: context.feedbackType,
        }),
        onDone: {
          target: "errorRouting",
          actions: assign({ errorAnalysis: ({ event }) => event.output }),
        },
        onError: { target: "storing" },
      },
    },

    errorRouting: {
      always: [
        {
          guard: ({ context }) =>
            context.errorAnalysis?.errorCategory === "style_mismatch",
          target: "storingErrorPreferences",
        },
        {
          guard: ({ context }) =>
            context.errorAnalysis !== null &&
            ["factual_error", "hallucination", "outdated_info"].includes(
              context.errorAnalysis.errorCategory
            ),
          target: "researching",
        },
        { target: "storing" },
      ],
    },

    storingErrorPreferences: {
      invoke: {
        src: "storePreferences",
        input: ({ context }) => ({
          userId: context.userId,
          updates: context.errorAnalysis?.suggestedPreferenceUpdates ?? [],
          source: "bad" as const,
        }),
        onDone: { target: "storing" },
        onError: { target: "storing" },
      },
    },

    researching: {
      invoke: {
        src: "research",
        input: ({ context }) => ({
          query:
            context.userCorrection ??
            context.errorAnalysis?.explanation ??
            context.originalResponse,
        }),
        onDone: {
          target: "reflecting",
          actions: assign({ researchResults: ({ event }) => event.output }),
        },
        onError: { target: "reflecting" },
      },
    },

    reflecting: {
      invoke: {
        src: "reflect",
        input: ({ context }) => ({
          originalMessage: context.originalMessage,
          originalResponse: context.originalResponse,
          errorAnalysis: context.errorAnalysis!,
          researchResults: context.researchResults,
        }),
        onDone: {
          target: "storing",
          actions: assign({
            resolution: ({ event }) =>
              `${event.output.correctedAnswer}\n\nRoot cause: ${event.output.rootCause}\nAvoidance rule: ${event.output.avoidanceRule}`,
          }),
        },
        onError: { target: "storing" },
      },
    },

    // ─── Common: Store Everything ─────────────────────────────────
    storing: {
      invoke: {
        src: "storeFeedback",
        input: ({ context }) => ({ context }),
        onDone: { target: "done" },
        onError: { target: "done" },
      },
    },

    done: {
      type: "final",
    },
  },

  output: ({ context }) => ({
    resolution: context.resolution,
    errorCategory: context.errorAnalysis?.errorCategory ?? null,
    positiveCategory: context.positiveAnalysis?.positiveCategory ?? null,
    patternsLearned: context.positiveAnalysis?.patternsToRepeat ?? [],
  }),
});
