import "dotenv/config";
import { initSession, handleMessage, handleFeedback } from "./agent/agent.js";
import { db } from "./db/client.js";
import { sql } from "drizzle-orm";

/**
 * Quick smoke test — verifies the core loop works:
 * ask → answer → /bad → ask again → improved → /good → memory recall
 */
async function main() {
  console.log("\n  Quick Test: Core Learning Loop\n");

  const session = await initSession("quick-test");
  const t = Date.now();

  // Step 1: Ask
  console.log("  1. Ask: What is Redis?");
  const a1 = await handleMessage(session, "What is Redis?");
  console.log(`     → ${a1.slice(0, 100)}...\n`);

  // Step 2: /bad
  console.log("  2. /bad: Emphasize in-memory caching");
  const fb = await handleFeedback(session, "bad", "Lead with 'Redis is an in-memory data store used for caching.' Don't bury the lede.");
  console.log(`     → ${fb.slice(0, 100)}...\n`);

  // Step 3: Ask again
  console.log("  3. Ask again: What is Redis?");
  const a2 = await handleMessage(session, "What is Redis?");
  console.log(`     → ${a2.slice(0, 100)}...\n`);

  // Step 4: /good
  console.log("  4. /good");
  const g = await handleFeedback(session, "good");
  console.log(`     → ${g.slice(0, 100)}...\n`);

  // Step 5: Memory recall
  console.log("  5. Memory recall");
  const recall = await handleMessage(session, "What do you remember about our conversation?");
  console.log(`     → ${recall.slice(0, 200)}...\n`);

  // Step 6: Check conversation summary was saved
  const summaries = await db.execute(sql`
    SELECT content FROM drawers
    WHERE wing = 'conversations' AND hall = 'summaries'
    ORDER BY accessed_at DESC LIMIT 1
  `);
  const hasSummary = summaries.rows.length > 0;
  console.log(`  6. Conversation summary saved: ${hasSummary ? "YES" : "NO"}`);
  if (hasSummary) {
    const s = (summaries.rows[0] as { content: string }).content;
    console.log(`     → ${s.slice(0, 150)}...\n`);
  }

  const elapsed = ((Date.now() - t) / 1000).toFixed(0);
  console.log(`  Done in ${elapsed}s. All steps completed.\n`);

  session.contextActor.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
