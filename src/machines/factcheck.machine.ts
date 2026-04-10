import { setup, assign, fromPromise } from "xstate";
import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../config.js";
import { searchVerifiedFacts } from "../palace/search.js";
import { searchWeb, type ExaResult } from "../search/exa.js";
import { storeDrawer } from "../palace/store.js";
import { embedText } from "../embeddings/gemini.js";
import { db } from "../db/client.js";
import { verifiedFacts } from "../db/schema.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Claim {
  text: string;
  type: "factual" | "opinion" | "preference" | "question";
}

interface VerificationResult {
  claim: string;
  verdict: "confirmed" | "refuted" | "partially_true" | "unverifiable";
  explanation: string;
  confidence: number;
  sources: Array<{ url: string; title: string; snippet: string }>;
}

interface FactCheckContext {
  originalMessage: string;
  claims: Claim[];
  currentClaimIndex: number;
  memoryResult: {
    claim: string;
    verdict: string;
    explanation: string;
    confidence: number;
  } | null;
  searchResults: ExaResult[];
  verifications: VerificationResult[];
  corrections: string[];
}

// ─── Actors ──────────────────────────────────────────────────────────────────

const extractClaimsActor = fromPromise(
  async ({ input }: { input: { message: string } }) => {
    const { object } = await generateObject({
      model: getModel("fast"),
      schema: z.object({
        claims: z.array(
          z.object({
            text: z.string(),
            type: z.enum(["factual", "opinion", "preference", "question"]),
          })
        ),
      }),
      prompt: `Extract any factual claims from this message. A factual claim is a verifiable statement about the real world (not opinions or preferences).

Message: "${input.message}"

For each claim, classify it as:
- "factual": a verifiable statement (e.g., "Python was created in 1991", "the sky is pink")
- "opinion": a subjective view (e.g., "React is the best framework")
- "preference": a personal preference (e.g., "I prefer dark mode")
- "question": asking for information

Only extract distinct claims. Do not rephrase — keep close to the original wording.`,
    });
    return object.claims;
  }
);

const checkMemoryActor = fromPromise(
  async ({ input }: { input: { claim: string } }) => {
    const results = await searchVerifiedFacts(input.claim, {
      limit: 3,
      maxAgeDays: 30,
    });

    // Use a high-confidence recent match if available
    const match = results.find((r) => r.confidence >= 0.8 && r.score >= 0.8);
    return match ?? null;
  }
);

const webSearchActor = fromPromise(
  async ({ input }: { input: { claim: string } }) => {
    return searchWeb(input.claim, { numResults: 5 });
  }
);

const evaluateClaimActor = fromPromise(
  async ({
    input,
  }: {
    input: {
      claim: string;
      searchResults: ExaResult[];
      memoryResult: { verdict: string; explanation: string } | null;
    };
  }) => {
    const evidence = input.searchResults
      .map(
        (r, i) =>
          `[${i + 1}] ${r.title}\n${r.url}\n${r.highlights.join(" ")}\n${r.text.slice(0, 500)}`
      )
      .join("\n\n");

    const memoryNote = input.memoryResult
      ? `\nPrevious verification: ${input.memoryResult.verdict} — ${input.memoryResult.explanation}`
      : "";

    const { object } = await generateObject({
      model: getModel("main"),
      schema: z.object({
        verdict: z.enum([
          "confirmed",
          "refuted",
          "partially_true",
          "unverifiable",
        ]),
        explanation: z
          .string()
          .describe("Clear explanation of why this verdict was reached"),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe("How confident are you in this verdict"),
        sources: z.array(
          z.object({
            url: z.string(),
            title: z.string(),
            snippet: z.string(),
          })
        ),
      }),
      prompt: `You are a fact checker. Evaluate this claim against the evidence provided.

CLAIM: "${input.claim}"
${memoryNote}

EVIDENCE:
${evidence || "No web search results found."}

Determine whether the claim is confirmed, refuted, partially true, or unverifiable based on the evidence. Be specific in your explanation. Cite sources.`,
    });

    return { claim: input.claim, ...object };
  }
);

const storeVerificationActor = fromPromise(
  async ({ input }: { input: { verification: VerificationResult } }) => {
    const v = input.verification;
    const embedding = await embedText(v.claim);

    // Store in verified_facts table
    await db.insert(verifiedFacts).values({
      claim: v.claim,
      verdict: v.verdict,
      explanation: v.explanation,
      sources: v.sources,
      confidence: v.confidence,
      embedding,
    });

    // Also store as a palace drawer for future memory retrieval
    await storeDrawer({
      wing: "system",
      hall: "facts",
      room: "verified",
      content: `[${v.verdict.toUpperCase()}] ${v.claim}\n${v.explanation}`,
      source: "fact-check",
    });

    return v;
  }
);

// ─── Machine ─────────────────────────────────────────────────────────────────

export const factCheckMachine = setup({
  types: {
    context: {} as FactCheckContext,
    events: {} as { type: "CHECK_MESSAGE"; message: string },
    input: {} as { message: string },
    output: {} as { corrections: string[]; verifications: VerificationResult[] },
  },
  actors: {
    extractClaims: extractClaimsActor,
    checkMemory: checkMemoryActor,
    webSearch: webSearchActor,
    evaluateClaim: evaluateClaimActor,
    storeVerification: storeVerificationActor,
  },
}).createMachine({
  id: "factChecker",
  initial: "classifying",
  context: ({ input }) => ({
    originalMessage: input.message,
    claims: [],
    currentClaimIndex: 0,
    memoryResult: null,
    searchResults: [],
    verifications: [],
    corrections: [],
  }),

  states: {
    classifying: {
      invoke: {
        src: "extractClaims",
        input: ({ context }) => ({ message: context.originalMessage }),
        onDone: [
          {
            // No factual claims → done
            guard: ({ event }) =>
              event.output.filter((c: Claim) => c.type === "factual")
                .length === 0,
            target: "done",
          },
          {
            target: "checkingMemory",
            actions: assign({
              claims: ({ event }) =>
                event.output.filter((c: Claim) => c.type === "factual"),
              currentClaimIndex: 0,
            }),
          },
        ],
        onError: { target: "done" },
      },
    },

    checkingMemory: {
      invoke: {
        src: "checkMemory",
        input: ({ context }) => ({
          claim: context.claims[context.currentClaimIndex]!.text,
        }),
        onDone: [
          {
            // Found a confident recent match — skip web search
            guard: ({ event }) => event.output !== null,
            target: "evaluating",
            actions: assign({
              memoryResult: ({ event }) => event.output,
            }),
          },
          {
            // Not in memory — search the web
            target: "searching",
            actions: assign({ memoryResult: null }),
          },
        ],
        onError: { target: "searching" },
      },
    },

    searching: {
      invoke: {
        src: "webSearch",
        input: ({ context }) => ({
          claim: context.claims[context.currentClaimIndex]!.text,
        }),
        onDone: {
          target: "evaluating",
          actions: assign({
            searchResults: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "evaluating",
          actions: assign({ searchResults: [] }),
        },
      },
    },

    evaluating: {
      invoke: {
        src: "evaluateClaim",
        input: ({ context }) => ({
          claim: context.claims[context.currentClaimIndex]!.text,
          searchResults: context.searchResults,
          memoryResult: context.memoryResult,
        }),
        onDone: {
          target: "storing",
          actions: assign({
            verifications: ({ context, event }) => [
              ...context.verifications,
              event.output,
            ],
          }),
        },
        onError: { target: "nextClaim" },
      },
    },

    storing: {
      invoke: {
        src: "storeVerification",
        input: ({ context }) => ({
          verification: context.verifications[context.verifications.length - 1]!,
        }),
        onDone: {
          target: "nextClaim",
          actions: assign({
            corrections: ({ context }) => {
              const latest =
                context.verifications[context.verifications.length - 1]!;
              if (
                latest.verdict === "refuted" ||
                latest.verdict === "partially_true"
              ) {
                return [
                  ...context.corrections,
                  `Claim: "${latest.claim}" — ${latest.verdict}: ${latest.explanation}`,
                ];
              }
              return context.corrections;
            },
          }),
        },
        onError: { target: "nextClaim" },
      },
    },

    nextClaim: {
      always: [
        {
          guard: ({ context }) =>
            context.currentClaimIndex + 1 < context.claims.length,
          target: "checkingMemory",
          actions: assign({
            currentClaimIndex: ({ context }) => context.currentClaimIndex + 1,
            memoryResult: null,
            searchResults: [],
          }),
        },
        { target: "done" },
      ],
    },

    done: {
      type: "final",
    },
  },

  output: ({ context }) => ({
    corrections: context.corrections,
    verifications: context.verifications,
  }),
});
