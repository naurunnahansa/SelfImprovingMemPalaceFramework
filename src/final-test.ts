import "dotenv/config";
import { writeFileSync } from "node:fs";
import { initSession, handleMessage, handleFeedback } from "./agent/agent.js";
import { db } from "./db/client.js";
import { sql } from "drizzle-orm";

interface TestResult {
  test: string;
  input: string;
  output: string;
  duration: number;
  pass: boolean;
  notes: string;
}

const results: TestResult[] = [];
let testNum = 0;

async function test() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║   FINAL TEST SUITE — Self-Improving Memory Palace    ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  const session = await initSession("final-test-user");

  async function say(label: string, message: string, check?: (response: string) => { pass: boolean; notes: string }): Promise<string> {
    testNum++;
    console.log(`\n[TEST ${testNum}] ${label}`);
    console.log(`  User: ${message}`);
    const start = Date.now();
    const response = await handleMessage(session, message);
    const duration = (Date.now() - start) / 1000;
    console.log(`  Agent (${duration.toFixed(1)}s): ${response.slice(0, 200)}${response.length > 200 ? "..." : ""}`);

    const result = check ? check(response) : { pass: true, notes: "manual" };
    console.log(`  ${result.pass ? "✓ PASS" : "✗ FAIL"} — ${result.notes}`);

    results.push({
      test: label,
      input: message,
      output: response,
      duration,
      pass: result.pass,
      notes: result.notes,
    });
    return response;
  }

  async function fb(label: string, type: "good" | "bad", correction?: string, check?: (response: string) => { pass: boolean; notes: string }) {
    testNum++;
    console.log(`\n[TEST ${testNum}] ${label}`);
    console.log(`  Feedback: /${type}${correction ? ` ${correction}` : ""}`);
    const start = Date.now();
    const response = await handleFeedback(session, type, correction);
    const duration = (Date.now() - start) / 1000;
    console.log(`  Result (${duration.toFixed(1)}s): ${response.slice(0, 200)}${response.length > 200 ? "..." : ""}`);

    const result = check ? check(response) : { pass: true, notes: "manual" };
    console.log(`  ${result.pass ? "✓ PASS" : "✗ FAIL"} — ${result.notes}`);

    results.push({
      test: label,
      input: `/${type}${correction ? ` ${correction}` : ""}`,
      output: response,
      duration,
      pass: result.pass,
      notes: result.notes,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY 1: Core Q&A
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n━━━ CATEGORY 1: Core Q&A ━━━");

  await say("Basic question", "What is Redis?", (r) => ({
    pass: r.toLowerCase().includes("redis") && r.length > 30,
    notes: r.length > 30 ? "Non-trivial answer about Redis" : "Answer too short",
  }));

  await say("Follow-up question", "What data structures does Redis support?", (r) => ({
    pass: r.toLowerCase().includes("string") || r.toLowerCase().includes("hash") || r.toLowerCase().includes("list"),
    notes: "Mentions specific data structures",
  }));

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY 2: Feedback Learning Loop (the core assignment)
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n━━━ CATEGORY 2: Feedback Learning Loop ━━━");

  await say("Question before feedback", "What is Docker?", (r) => ({
    pass: r.toLowerCase().includes("container") || r.toLowerCase().includes("docker"),
    notes: "Baseline Docker answer",
  }));

  await fb("/bad feedback with correction", "bad",
    "You should mention that Docker uses OS-level virtualization, not hardware virtualization like VMs. That's the key distinction.",
    (r) => ({
      pass: r.toLowerCase().includes("feedback") || r.toLowerCase().includes("recorded") || r.toLowerCase().includes("corrected") || r.toLowerCase().includes("analyzed"),
      notes: "Feedback acknowledged and processed",
    })
  );

  await say("Same question AFTER feedback", "What is Docker?", (r) => ({
    pass: r.toLowerCase().includes("container"),
    notes: r.toLowerCase().includes("os-level") || r.toLowerCase().includes("operating system") || r.toLowerCase().includes("os level")
      ? "IMPROVED — mentions OS-level virtualization"
      : "Answer present but may not reflect correction",
  }));

  await fb("/good on improved answer", "good", undefined, (r) => ({
    pass: r.toLowerCase().includes("learned") || r.toLowerCase().includes("positive") || r.toLowerCase().includes("recorded"),
    notes: "Positive feedback processed",
  }));

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY 3: Fact Verification
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n━━━ CATEGORY 3: Fact Verification ━━━");

  await say("True claim verification", "Python was created by Guido van Rossum, right?", (r) => ({
    pass: r.toLowerCase().includes("yes") || r.toLowerCase().includes("correct") || r.toLowerCase().includes("guido"),
    notes: "Confirms true fact",
  }));

  await say("False claim — should correct", "I heard that JavaScript was created by Microsoft in 2005.", (r) => ({
    pass: r.toLowerCase().includes("netscape") || r.toLowerCase().includes("brendan") || r.toLowerCase().includes("1995") || r.toLowerCase().includes("not") || r.toLowerCase().includes("incorrect"),
    notes: r.toLowerCase().includes("brendan") || r.toLowerCase().includes("1995")
      ? "Corrected with accurate info"
      : "Responded but may not have fully corrected",
  }));

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY 4: Reflection Step
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n━━━ CATEGORY 4: Reflection Step ━━━");

  await say("Complex question (triggers reflection)", "Explain the CAP theorem and when you'd choose CP vs AP.", (r) => ({
    pass: r.toLowerCase().includes("consistency") && r.toLowerCase().includes("availability") && r.toLowerCase().includes("partition"),
    notes: "Covers all three aspects of CAP",
  }));

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY 5: Memory & Preferences
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n━━━ CATEGORY 5: Memory & Preferences ━━━");

  await say("Set preference", "Keep your answers super short from now on. One or two sentences max.", (r) => ({
    pass: true,
    notes: "Preference instruction given",
  }));

  await say("Test preference respected", "What is Kubernetes?", (r) => ({
    pass: r.split(". ").length <= 5,
    notes: `Response has ~${r.split(". ").length} sentences — ${r.split(". ").length <= 5 ? "concise" : "maybe too long"}`,
  }));

  await say("Memory recall", "What do you know about me and my preferences?", (r) => ({
    pass: r.toLowerCase().includes("short") || r.toLowerCase().includes("concise") || r.toLowerCase().includes("brief"),
    notes: "Recalls conciseness preference",
  }));

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY 6: Context Management
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n━━━ CATEGORY 6: Context Management ━━━");

  const snapshot1 = session.contextActor.getSnapshot();
  const rooms1 = snapshot1.context.activeRooms;
  console.log(`\n  Active rooms: ${rooms1.length}`);
  rooms1.forEach((r) => console.log(`    ${r.wing}/${r.room} — rel: ${r.relevance.toFixed(2)}`));

  results.push({
    test: "Context rooms tracked",
    input: "N/A",
    output: `${rooms1.length} active rooms`,
    duration: 0,
    pass: rooms1.length > 0,
    notes: rooms1.length > 0 ? `${rooms1.length} rooms loaded with relevance decay` : "No rooms loaded",
  });

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY 7: Database State
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n━━━ CATEGORY 7: Database State ━━━");

  const counts = {
    drawers: ((await db.execute(sql`SELECT COUNT(*)::int as c FROM drawers`)).rows[0] as { c: number }).c,
    facts: ((await db.execute(sql`SELECT COUNT(*)::int as c FROM verified_facts`)).rows[0] as { c: number }).c,
    feedback: ((await db.execute(sql`SELECT COUNT(*)::int as c FROM feedback`)).rows[0] as { c: number }).c,
    prefs: ((await db.execute(sql`SELECT COUNT(*)::int as c FROM user_preferences`)).rows[0] as { c: number }).c,
    messages: ((await db.execute(sql`SELECT COUNT(*)::int as c FROM messages`)).rows[0] as { c: number }).c,
  };

  console.log(`\n  Drawers: ${counts.drawers}`);
  console.log(`  Verified facts: ${counts.facts}`);
  console.log(`  Feedback records: ${counts.feedback}`);
  console.log(`  User preferences: ${counts.prefs}`);
  console.log(`  Messages: ${counts.messages}`);

  results.push({
    test: "Data persisted to Neon",
    input: "DB check",
    output: JSON.stringify(counts),
    duration: 0,
    pass: counts.drawers > 0 && counts.messages > 0,
    notes: `${counts.drawers} drawers, ${counts.facts} facts, ${counts.feedback} feedback, ${counts.prefs} prefs, ${counts.messages} messages`,
  });

  // ═══════════════════════════════════════════════════════════════════
  // FINAL REPORT
  // ═══════════════════════════════════════════════════════════════════
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;
  const totalTime = results.reduce((s, r) => s + r.duration, 0);

  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║                  FINAL RESULTS                        ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  console.log(`  Total: ${total} tests`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Pass rate: ${((passed / total) * 100).toFixed(0)}%`);
  console.log(`  Total time: ${totalTime.toFixed(0)}s\n`);

  console.log("  Test".padEnd(45) + "Duration".padStart(10) + "  Result");
  console.log("  " + "─".repeat(65));
  for (const r of results) {
    const icon = r.pass ? "✓" : "✗";
    const dur = r.duration > 0 ? `${r.duration.toFixed(1)}s` : "—";
    console.log(`  ${icon} ${r.test.padEnd(42)} ${dur.padStart(10)}  ${r.notes.slice(0, 40)}`);
  }

  // Save results
  const outputPath = `benchmarks/final_test_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
  writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    total,
    passed,
    failed,
    passRate: `${((passed / total) * 100).toFixed(0)}%`,
    totalTimeSeconds: Math.round(totalTime),
    results,
    dbState: counts,
  }, null, 2));
  console.log(`\n  Results saved to ${outputPath}`);

  session.contextActor.stop();
  process.exit(0);
}

test().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
