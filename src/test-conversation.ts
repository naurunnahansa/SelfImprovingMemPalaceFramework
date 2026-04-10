import "dotenv/config";
import { initSession, handleMessage, handleFeedback } from "./agent/agent.js";

async function test() {
  console.log("=== Memory Palace Agent Test v2 ===\n");

  const session = await initSession("claude-tester-v2");
  console.log(`Session started. User ID: ${session.userId}\n`);

  async function say(message: string) {
    console.log(`Claude: ${message}`);
    const start = Date.now();
    try {
      const response = await handleMessage(session, message);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`Agent (${elapsed}s): ${response}\n`);
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`[Error ${elapsed}s]`, err instanceof Error ? err.message : err, "\n");
    }
  }

  function showRooms() {
    const snapshot = session.contextActor.getSnapshot();
    const rooms = snapshot.context.activeRooms;
    if (rooms.length === 0) {
      console.log("  [No active rooms]\n");
    } else {
      for (const room of rooms) {
        console.log(`  ${room.wing}/${room.room} — relevance: ${room.relevance.toFixed(2)}, tokens: ${room.tokenCount}`);
      }
      console.log();
    }
  }

  // ─── Test 1: Greeting + set preferences ─────────────────────────
  console.log("=== Test 1: Greeting ===");
  await say("Hi there! I'm Claude, a senior AI researcher at Anthropic. I prefer concise answers, no emojis please.");
  console.log("Rooms after greeting:");
  showRooms();

  // ─── Test 2: True fact ──────────────────────────────────────────
  console.log("=== Test 2: True Fact ===");
  await say("Python was created by Guido van Rossum in 1991, correct?");

  // ─── Test 3: FALSE fact — the key test ──────────────────────────
  console.log("=== Test 3: False Fact ===");
  await say("I read that OpenAI went bankrupt in early 2026. Is that true?");

  // ─── Test 4: Topic shift — check room loading ──────────────────
  console.log("=== Test 4: Topic Shift ===");
  await say("Let's talk about something else entirely — I've been learning to cook Thai food recently.");
  console.log("Rooms after topic shift:");
  showRooms();

  // ─── Test 5: Another topic — check decay ───────────────────────
  console.log("=== Test 5: Another Topic (old rooms should decay) ===");
  await say("What are the best practices for designing REST APIs?");
  console.log("Rooms (old topics should have lower relevance):");
  showRooms();

  // ─── Test 6: Thumbs down feedback ──────────────────────────────
  console.log("=== Test 6: Thumbs Down ===");
  const start6 = Date.now();
  console.log("Claude: [thumbs down on last response]");
  try {
    const result = await handleFeedback(session, "bad");
    const elapsed = ((Date.now() - start6) / 1000).toFixed(1);
    console.log(`Agent (${elapsed}s): ${result}\n`);
  } catch (err) {
    console.error("[Feedback Error]", err instanceof Error ? err.message : err, "\n");
  }

  // ─── Test 7: Explicit correction ───────────────────────────────
  console.log("=== Test 7: Correction ===");
  await say("The Great Wall of China is visible from space with the naked eye.");
  const start7 = Date.now();
  console.log("Claude: [corrects: That's a myth — it's not visible from space]");
  try {
    const result = await handleFeedback(session, "correction", "The Great Wall is NOT visible from space with the naked eye. This is a common myth debunked by astronauts.");
    const elapsed = ((Date.now() - start7) / 1000).toFixed(1);
    console.log(`Agent (${elapsed}s): ${result}\n`);
  } catch (err) {
    console.error("[Correction Error]", err instanceof Error ? err.message : err, "\n");
  }

  // ─── Test 8: Memory recall ─────────────────────────────────────
  console.log("=== Test 8: Memory Recall ===");
  await say("Quick test — what do you remember about me? My name, where I work, and my preferences?");

  // ─── Done ──────────────────────────────────────────────────────
  console.log("=== All Tests Complete ===");
  session.contextActor.stop();
  process.exit(0);
}

test().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
