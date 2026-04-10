import "dotenv/config";
import { initSession, handleMessage, handleFeedback } from "./agent/agent.js";

/**
 * Demo script showing the agent learning from feedback.
 *
 * Flow:
 * 1. User asks a question → agent answers
 * 2. User gives /bad feedback → agent researches, reflects, stores correction
 * 3. User asks the same question → agent gives improved answer
 * 4. User gives /good feedback → agent reinforces the pattern
 */
async function demo() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Memory Palace Agent — Learning Demo       ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const session = await initSession("demo-user");

  async function say(message: string): Promise<string> {
    console.log(`\x1b[36mUser:\x1b[0m ${message}`);
    const start = Date.now();
    const response = await handleMessage(session, message);
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\x1b[33mAgent (${dur}s):\x1b[0m ${response}\n`);
    return response;
  }

  async function feedback(type: "good" | "bad", correction?: string) {
    const label = type === "good" ? "/good" : `/bad${correction ? ` ${correction}` : ""}`;
    console.log(`\x1b[32m[Feedback]\x1b[0m ${label}`);
    const start = Date.now();
    const result = await handleFeedback(session, type, correction);
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\x1b[32m[Result ${dur}s]\x1b[0m ${result}\n`);
  }

  // ── Step 1: Ask a question ────────────────────────────────────────
  console.log("━━━ Step 1: Initial Question ━━━\n");
  await say("What is Redis?");

  // ── Step 2: Give /bad feedback with correction ────────────────────
  console.log("━━━ Step 2: Provide Feedback ━━━\n");
  await feedback(
    "bad",
    "Your answer should emphasize that Redis is primarily used as an in-memory data store and cache, not just describe it generically. Mention that it supports data structures like strings, hashes, lists, sets, and sorted sets."
  );

  // ── Step 3: Ask the same question again ───────────────────────────
  console.log("━━━ Step 3: Ask Again (agent should improve) ━━━\n");
  await say("What is Redis?");

  // ── Step 4: Give /good feedback ───────────────────────────────────
  console.log("━━━ Step 4: Positive Reinforcement ━━━\n");
  await feedback("good");

  // ── Step 5: Ask a related question ────────────────────────────────
  console.log("━━━ Step 5: Related Question (agent uses learned context) ━━━\n");
  await say("When should I use Redis vs PostgreSQL?");

  // ── Step 6: Verify memory ─────────────────────────────────────────
  console.log("━━━ Step 6: Memory Check ━━━\n");
  await say("What have you learned about my preferences so far?");

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Demo Complete                              ║");
  console.log("╚══════════════════════════════════════════════╝");

  session.contextActor.stop();
  process.exit(0);
}

demo().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
