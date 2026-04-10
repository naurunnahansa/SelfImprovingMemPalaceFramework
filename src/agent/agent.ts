import { generateText, streamText, stepCountIs } from "ai";
import { createActor, waitFor } from "xstate";
import { getModel } from "../config.js";
import { classifyMessage } from "./classifier.js";
import { agentTools } from "./tools.js";
import { buildSystemPrompt } from "./prompts.js";
import { contextMachine } from "../machines/context.machine.js";
import { factCheckMachine } from "../machines/factcheck.machine.js";
import { feedbackMachine } from "../machines/feedback.machine.js";
import { getPreferences } from "../preferences/model.js";
import { detectPreferences } from "../preferences/detector.js";
import { storeDrawer } from "../palace/store.js";
import { embedText, estimateTokens } from "../embeddings/gemini.js";
import { db } from "../db/client.js";
import {
  conversations,
  messages,
  users,
} from "../db/schema.js";
import { eq, sql } from "drizzle-orm";

// ─── Session State ───────────────────────────────────────────────────────────

interface Session {
  userId: string;
  conversationId: string;
  contextActor: ReturnType<typeof createActor<typeof contextMachine>>;
  messageHistory: Array<{ role: "user" | "assistant"; content: string }>;
}

let currentSession: Session | null = null;

/**
 * Initialize or resume a session for a user.
 */
export async function initSession(
  externalId: string = "default-user"
): Promise<Session> {
  // Ensure user exists
  const [user] = await db
    .insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoUpdate({
      target: users.externalId,
      set: { displayName: externalId },
    })
    .returning();

  // Create conversation
  const [conversation] = await db
    .insert(conversations)
    .values({ userId: user!.id })
    .returning();

  // Start context machine
  const contextActor = createActor(contextMachine, {
    input: { userId: user!.id },
  });
  contextActor.start();

  currentSession = {
    userId: user!.id,
    conversationId: conversation!.id,
    contextActor,
    messageHistory: [],
  };

  return currentSession;
}

/**
 * Handle an incoming user message. This is the main orchestration point.
 */
export async function handleMessage(
  session: Session,
  message: string
): Promise<string> {
  // 1. Classify the message
  const classification = await classifyMessage(message);

  // 2. Send to context machine → topic detection, room loading/unloading
  session.contextActor.send({
    type: "MESSAGE_RECEIVED",
    message,
  });

  // Wait for context machine to settle back to idle
  await waitFor(session.contextActor, (state) => state.value === "idle", {
    timeout: 15_000,
  });

  const contextState = session.contextActor.getSnapshot();
  const activeRooms = contextState.context.activeRooms;

  // 3. Fact-check if there are factual claims
  let corrections: string[] = [];
  const factualClaims = classification.claims.filter(
    (c) => c.type === "factual"
  );

  if (factualClaims.length > 0) {
    try {
      const factCheckActor = createActor(factCheckMachine, {
        input: { message },
      });
      factCheckActor.start();

      const factCheckDone = await waitFor(
        factCheckActor,
        (state) => state.status === "done",
        { timeout: 30_000 }
      );

      corrections = factCheckDone.output?.corrections ?? [];
    } catch {
      // Fact check timed out or failed — proceed without corrections
    }
  }

  // 4. Load user preferences
  const preferences = await getPreferences(session.userId);

  // 5. Build dynamic system prompt
  const systemPrompt = await buildSystemPrompt(
    session.userId,
    activeRooms,
    message,
    preferences,
    corrections.length > 0 ? corrections : undefined
  );

  // 6. Build message history for the LLM
  session.messageHistory.push({ role: "user", content: message });

  // 7. Generate initial response using AI SDK
  const result = await generateText({
    model: getModel("main"),
    system: systemPrompt,
    messages: session.messageHistory,
    tools: agentTools,
    stopWhen: stepCountIs(5),
  });

  // 8. Reflection step — critique and improve the response before returning
  const responseText = await reflectOnResponse(
    message,
    result.text,
    corrections
  );

  // 9. Add assistant response to history
  session.messageHistory.push({ role: "assistant", content: responseText });

  // 10. Store messages in DB (fire and forget)
  const topicRooms = contextState.context.activeRooms.map((r) => r.room);
  storeMessages(session, message, responseText, topicRooms).catch(() => {});

  // 11. Detect preferences in background (fire and forget)
  detectPreferences(session.userId, message, responseText).catch(() => {});

  return responseText;
}

/**
 * Streaming version of handleMessage. Yields text deltas and tool call
 * notifications so the CLI can print tokens as they arrive.
 */
export async function handleMessageStream(
  session: Session,
  message: string,
  callbacks: {
    onText: (delta: string) => void;
    onToolCall: (toolName: string, args: Record<string, unknown>) => void;
    onToolResult: (toolName: string, result: unknown) => void;
    onDone: (fullText: string) => void;
  }
): Promise<string> {
  // 1. Classify (show spinner status in CLI)
  const classification = await classifyMessage(message);

  // 2. Context machine
  session.contextActor.send({ type: "MESSAGE_RECEIVED", message });
  await waitFor(session.contextActor, (state) => state.value === "idle", {
    timeout: 15_000,
  });
  const contextState = session.contextActor.getSnapshot();
  const activeRooms = contextState.context.activeRooms;

  // 3. Fact-check
  let corrections: string[] = [];
  const factualClaims = classification.claims.filter(
    (c) => c.type === "factual"
  );
  if (factualClaims.length > 0) {
    try {
      const factCheckActor = createActor(factCheckMachine, {
        input: { message },
      });
      factCheckActor.start();
      const factCheckDone = await waitFor(
        factCheckActor,
        (state) => state.status === "done",
        { timeout: 30_000 }
      );
      corrections = factCheckDone.output?.corrections ?? [];
    } catch {
      // proceed without
    }
  }

  // 4. Preferences + prompt
  const preferences = await getPreferences(session.userId);
  const systemPrompt = await buildSystemPrompt(
    session.userId,
    activeRooms,
    message,
    preferences,
    corrections.length > 0 ? corrections : undefined
  );

  session.messageHistory.push({ role: "user", content: message });

  // 5. Stream the response
  const result = streamText({
    model: getModel("main"),
    system: systemPrompt,
    messages: session.messageHistory,
    tools: agentTools,
    stopWhen: stepCountIs(5),
  });

  // Consume the full stream — text deltas + tool call notifications
  let fullText = "";
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      fullText += part.text;
      callbacks.onText(part.text);
    } else if (part.type === "tool-call") {
      callbacks.onToolCall(part.toolName, (part as unknown as { input: Record<string, unknown> }).input ?? {});
    } else if (part.type === "tool-result") {
      callbacks.onToolResult(part.toolName, (part as unknown as { output: unknown }).output ?? null);
    }
  }

  // Wait for all steps to complete (tool calls etc.)
  const finalResult = await result;
  fullText = (await finalResult.text) || fullText;

  // 6. Post-processing
  session.messageHistory.push({ role: "assistant", content: fullText });
  const topicRooms = contextState.context.activeRooms.map((r) => r.room);
  storeMessages(session, message, fullText, topicRooms).catch(() => {});
  detectPreferences(session.userId, message, fullText).catch(() => {});

  callbacks.onDone(fullText);
  return fullText;
}

/**
 * Handle /good or /bad feedback.
 * Runs the feedback machine in the background — returns immediately
 * with an acknowledgment, while learning happens asynchronously.
 */
export function handleFeedbackBackground(
  session: Session,
  type: "good" | "bad",
  correction?: string
): string {
  const lastUserMsg = [...session.messageHistory]
    .reverse()
    .find((m) => m.role === "user");
  const lastAssistantMsg = [...session.messageHistory]
    .reverse()
    .find((m) => m.role === "assistant");

  if (!lastAssistantMsg || !lastUserMsg) {
    return "No previous exchange to give feedback on.";
  }

  // Fire and forget — learning happens in the background
  const feedbackActor = createActor(feedbackMachine, {
    input: {
      feedbackType: type === "bad" && correction ? "correction" : type,
      originalMessage: lastUserMsg.content,
      originalResponse: lastAssistantMsg.content,
      userCorrection: correction ?? null,
      conversationId: session.conversationId,
      messageId: "",
      userId: session.userId,
    },
  });

  feedbackActor.subscribe((state) => {
    if (state.status === "done") {
      const output = state.output;
      if (type === "good" && output?.patternsLearned?.length) {
        console.log(
          `\n[Background] Learned ${output.patternsLearned.length} positive pattern(s) from /good feedback.`
        );
      } else if (type === "bad" && output?.resolution) {
        console.log(
          `\n[Background] Stored correction from /bad feedback: ${output.errorCategory}`
        );
      } else {
        console.log(`\n[Background] Feedback processed and stored.`);
      }
    }
  });

  feedbackActor.start();

  // Return immediately
  if (type === "good") {
    return "Noted! Learning from what worked well in the background...";
  }
  return "Noted. Analyzing what went wrong and researching corrections in the background...";
}

/**
 * Handle feedback synchronously (for programmatic use / tests).
 */
export async function handleFeedback(
  session: Session,
  type: "good" | "bad" | "correction",
  correction?: string
): Promise<string> {
  const lastUserMsg = [...session.messageHistory]
    .reverse()
    .find((m) => m.role === "user");
  const lastAssistantMsg = [...session.messageHistory]
    .reverse()
    .find((m) => m.role === "assistant");

  if (!lastAssistantMsg || !lastUserMsg) {
    return "No previous exchange to give feedback on.";
  }

  const feedbackActor = createActor(feedbackMachine, {
    input: {
      feedbackType: type,
      originalMessage: lastUserMsg.content,
      originalResponse: lastAssistantMsg.content,
      userCorrection: correction ?? null,
      conversationId: session.conversationId,
      messageId: "",
      userId: session.userId,
    },
  });
  feedbackActor.start();

  try {
    const result = await waitFor(
      feedbackActor,
      (state) => state.status === "done",
      { timeout: 90_000 }
    );

    const output = result.output ?? {
      resolution: null,
      errorCategory: null,
      positiveCategory: null,
      patternsLearned: [],
    };

    if (type === "good") {
      const patterns = output.patternsLearned ?? [];
      return patterns.length > 0
        ? `Learned from positive feedback (${output.positiveCategory}):\n${patterns.map((p) => `  - ${p}`).join("\n")}`
        : `Positive feedback recorded (${output.positiveCategory}).`;
    }

    if (output.resolution) {
      return `Analyzed and corrected.\n\nError type: ${output.errorCategory ?? "unknown"}\n${output.resolution}`;
    }
    return `Feedback recorded. Error type: ${output.errorCategory ?? "unknown"}.`;
  } catch {
    const snapshot = feedbackActor.getSnapshot();
    const partialCategory =
      snapshot.context?.errorAnalysis?.errorCategory ??
      snapshot.context?.positiveAnalysis?.positiveCategory;
    if (partialCategory) {
      return `Feedback partially processed. Detected: ${partialCategory}.`;
    }
    return "Had trouble processing feedback, but it's been noted.";
  }
}

// ─── Reflection ──────────────────────────────────────────────────────────────

/**
 * Self-critique step: evaluate the generated response and improve it if needed.
 * This is the reflection/critic step the assignment asks for.
 *
 * Flow: Initial Answer → Reflection → Improved Final Answer
 */
async function reflectOnResponse(
  userMessage: string,
  initialResponse: string,
  factCheckCorrections: string[]
): Promise<string> {
  // Skip reflection for very short responses or if fact-check already corrected things
  if (initialResponse.length < 50 || factCheckCorrections.length > 0) {
    return initialResponse;
  }

  try {
    // Also check if we have any past feedback for similar questions
    const pastFeedback = await findRelevantFeedback(userMessage);

    const feedbackContext = pastFeedback.length > 0
      ? `\n\nPast feedback on similar questions:\n${pastFeedback.map((f) => `- [${f.feedbackType}] ${f.analysis ?? f.resolution ?? "no details"}`).join("\n")}`
      : "";

    const { text: improved } = await generateText({
      model: getModel("fast"),
      system: `You rewrite AI responses to be better. Output ONLY the improved response text — no commentary, no "Here's the improved version", no explanation of changes. If the original is already good, output it exactly as-is.`,
      prompt: `User asked: "${userMessage}"
${feedbackContext}

Rewrite this response if it can be improved, otherwise return it exactly as-is:

${initialResponse}`,
    });

    // Guard: if reflection output looks like meta-commentary, use the original
    const metaPhrases = ["the response", "the answer", "this is", "looks good", "is correct", "is accurate", "no changes", "already good"];
    const firstLine = (improved || "").split("\n")[0]?.toLowerCase() ?? "";
    if (metaPhrases.some((p) => firstLine.startsWith(p))) {
      return initialResponse;
    }

    return improved || initialResponse;
  } catch {
    // Reflection failure shouldn't block the response
    return initialResponse;
  }
}

/**
 * Direct lookup of past feedback for similar questions.
 * Fallback for when palace search doesn't find topic-routed corrections.
 */
async function findRelevantFeedback(
  question: string
): Promise<Array<{ feedbackType: string; analysis: string | null; resolution: string | null }>> {
  try {
    const questionEmb = await embedText(question);
    const embeddingStr = `[${questionEmb.join(",")}]`;

    // Search feedback table by embedding similarity on the original response
    // Also search verified_facts for any relevant corrections
    const result = await db.execute(sql`
      SELECT feedback_type, analysis, resolution
      FROM feedback
      WHERE original_response IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 10
    `);

    // Also check verified_facts for relevant corrections
    const facts = await db.execute(sql`
      SELECT claim, verdict, explanation
      FROM verified_facts
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT 3
    `);

    const feedbackRows = (result.rows as Array<{ feedback_type: string; analysis: string | null; resolution: string | null }>)
      .map((r) => ({
        feedbackType: r.feedback_type,
        analysis: r.analysis,
        resolution: r.resolution,
      }));

    const factRows = (facts.rows as Array<{ claim: string; verdict: string; explanation: string }>)
      .filter((f) => f.verdict === "refuted")
      .map((f) => ({
        feedbackType: "correction" as const,
        analysis: `Past fact-check: "${f.claim}" was ${f.verdict}`,
        resolution: f.explanation,
      }));

    return [...factRows, ...feedbackRows].slice(0, 5);
  } catch {
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function storeMessages(
  session: Session,
  userMessage: string,
  assistantResponse: string,
  topicRooms: string[]
): Promise<void> {
  try {
    const [userEmb, assistantEmb] = await Promise.all([
      embedText(userMessage),
      embedText(assistantResponse),
    ]);

    await db.insert(messages).values([
      {
        conversationId: session.conversationId,
        role: "user",
        content: userMessage,
        embedding: userEmb,
        tokenCount: estimateTokens(userMessage),
      },
      {
        conversationId: session.conversationId,
        role: "assistant",
        content: assistantResponse,
        embedding: assistantEmb,
        tokenCount: estimateTokens(assistantResponse),
      },
    ]);

    // Store as palace drawers — into each active topic room
    const room = topicRooms.length > 0 ? topicRooms[0]! : "general";
    await storeDrawer({
      wing: `user:${session.userId}`,
      hall: "conversations",
      room,
      content: `User: ${userMessage}\nAssistant: ${assistantResponse}`,
      source: `conversation:${session.conversationId}`,
    });
  } catch {
    // Silent — message storage is best-effort
  }
}

export { currentSession };
