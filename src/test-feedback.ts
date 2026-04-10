import "dotenv/config";
import { initSession, handleMessage, handleFeedback } from "./agent/agent.js";
import { hybridSearch } from "./palace/search.js";
import { db } from "./db/client.js";
import { sql } from "drizzle-orm";

async function test() {
  console.log("=== Feedback System Deep Test ===\n");

  const session = await initSession("feedback-tester");
  console.log(`Session started. User ID: ${session.userId}\n`);

  const start = Date.now();
  function elapsed() {
    return ((Date.now() - start) / 1000).toFixed(1) + "s";
  }

  async function say(message: string): Promise<string> {
    console.log(`\nUser: ${message}`);
    const t = Date.now();
    const response = await handleMessage(session, message);
    const dur = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`Agent (${dur}s): ${response}\n`);
    return response;
  }

  async function giveFeedback(type: "good" | "bad", correction?: string) {
    console.log(`--- /${type}${correction ? ` ${correction}` : ""} ---`);
    const t = Date.now();
    const result = await handleFeedback(session, type, correction);
    const dur = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`Feedback result (${dur}s): ${result}\n`);
    return result;
  }

  async function checkPalace(query: string, hall?: string) {
    const results = await hybridSearch(query, { hall, limit: 5 });
    if (results.length === 0) {
      console.log(`  Palace search "${query}"${hall ? ` (hall: ${hall})` : ""}: NO RESULTS`);
    } else {
      console.log(`  Palace search "${query}"${hall ? ` (hall: ${hall})` : ""}: ${results.length} results`);
      for (const r of results.slice(0, 3)) {
        console.log(`    [${r.wing}/${r.hall}/${r.room}] ${r.content.slice(0, 120)}...`);
      }
    }
    console.log();
  }

  async function checkVerifiedFacts(query: string) {
    const result = await db.execute(
      sql`SELECT claim, verdict, explanation FROM verified_facts ORDER BY checked_at DESC LIMIT 3`
    );
    if (result.rows.length === 0) {
      console.log(`  Verified facts: NONE`);
    } else {
      console.log(`  Recent verified facts:`);
      for (const r of result.rows) {
        const row = r as { claim: string; verdict: string; explanation: string };
        console.log(`    [${row.verdict}] ${row.claim.slice(0, 80)}...`);
        console.log(`      → ${row.explanation.slice(0, 100)}...`);
      }
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 1: /good on a factual answer → should store in topic room
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══ TEST 1: /good on factual answer ═══");
  await say("What language is the Linux kernel written in?");
  await giveFeedback("good");

  console.log("Checking palace for positive learnings...");
  await checkPalace("linux kernel good pattern", "learnings");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 2: /bad on a factual error → should research + correct + store in topic room
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══ TEST 2: /bad on factual error (with correction) ═══");
  await say("How many planets are in our solar system?");
  await giveFeedback("bad", "You forgot to mention that Pluto was reclassified as a dwarf planet in 2006 by the IAU. The answer should mention this context.");

  console.log("Checking palace for correction in topic room...");
  await checkPalace("pluto planet correction", "corrections");
  console.log("Checking verified facts...");
  await checkVerifiedFacts("planets");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 3: /bad on a style issue → should update preferences
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══ TEST 3: /bad on style (too verbose) ═══");
  await say("What is a variable in programming?");
  await giveFeedback("bad", "Way too verbose. I already know programming basics. Just give me the one-liner.");

  console.log("Checking preferences were updated...");
  const prefs = await db.execute(
    sql`SELECT category, key, value, confidence, learned_from FROM user_preferences WHERE user_id = ${session.userId} ORDER BY updated_at DESC LIMIT 5`
  );
  if (prefs.rows.length > 0) {
    console.log("  User preferences:");
    for (const p of prefs.rows) {
      const row = p as { category: string; key: string; value: string; confidence: number; learned_from: string };
      console.log(`    ${row.category}/${row.key}: ${row.value} (confidence: ${row.confidence}, from: ${row.learned_from})`);
    }
  } else {
    console.log("  No preferences stored.");
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // TEST 4: /good on a concise answer → should learn style pattern
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══ TEST 4: /good on concise style ═══");
  await say("What's the time complexity of binary search?");
  await giveFeedback("good");

  console.log("Checking for universal patterns...");
  await checkPalace("universal pattern", "learnings");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 5: /bad on hallucination → should research + ground + store
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══ TEST 5: /bad on potential hallucination ═══");
  await say("Tell me about the founder of Stripe.");
  await giveFeedback("bad", "You got some details wrong about Patrick Collison. Double check his background.");

  console.log("Checking for Stripe/Collison correction...");
  await checkPalace("stripe collison correction", "corrections");
  await checkPalace("stripe collison", "learnings");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 6: Does the agent USE past learnings?
  // Ask about the same topic after /bad was given.
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══ TEST 6: Does the agent use past corrections? ═══");
  console.log("Asking about planets again (after correction about Pluto)...\n");
  await say("How many planets does our solar system have?");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 7: Multiple /good signals → confidence should increase
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══ TEST 7: Multiple /good → confidence boost ═══");
  await say("Explain TCP vs UDP in one sentence each.");
  await giveFeedback("good");
  await say("Explain REST vs GraphQL in one sentence each.");
  await giveFeedback("good");

  console.log("Checking preference confidence after multiple /good signals...");
  const prefsAfter = await db.execute(
    sql`SELECT category, key, value, confidence, learned_from FROM user_preferences WHERE user_id = ${session.userId} ORDER BY confidence DESC LIMIT 5`
  );
  if (prefsAfter.rows.length > 0) {
    console.log("  Top preferences by confidence:");
    for (const p of prefsAfter.rows) {
      const row = p as { category: string; key: string; value: string; confidence: number; learned_from: string };
      console.log(`    ${row.category}/${row.key}: ${row.value} (confidence: ${Number(row.confidence).toFixed(3)}, from: ${row.learned_from})`);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══ FINAL STATE ═══");

  const drawerCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM drawers`);
  const factCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM verified_facts`);
  const feedbackCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM feedback`);
  const prefCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM user_preferences WHERE user_id = ${session.userId}`);

  console.log(`  Drawers in palace: ${(drawerCount.rows[0] as { count: number }).count}`);
  console.log(`  Verified facts: ${(factCount.rows[0] as { count: number }).count}`);
  console.log(`  Feedback records: ${(feedbackCount.rows[0] as { count: number }).count}`);
  console.log(`  User preferences: ${(prefCount.rows[0] as { count: number }).count}`);
  console.log(`  Total time: ${elapsed()}`);

  console.log("\n═══ ALL FEEDBACK TESTS COMPLETE ═══");
  session.contextActor.stop();
  process.exit(0);
}

test().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
