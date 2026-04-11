import "dotenv/config";
import { writeFileSync } from "node:fs";
import { initSession, handleMessage, handleFeedback } from "./agent/agent.js";

interface Turn {
  role: "user" | "agent" | "feedback";
  content: string;
  duration?: number;
}

interface ConversationLog {
  title: string;
  description: string;
  turns: Turn[];
}

const conversations: ConversationLog[] = [];

async function runConversation(
  title: string,
  description: string,
  steps: Array<
    | { say: string }
    | { feedback: "good" | "bad"; correction?: string }
  >
) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`  ${description}`);
  console.log(`${"═".repeat(60)}\n`);

  const session = await initSession(`example-${Date.now()}`);
  const turns: Turn[] = [];

  for (const step of steps) {
    if ("say" in step) {
      console.log(`  User: ${step.say}`);
      const start = Date.now();
      const response = await handleMessage(session, step.say);
      const duration = (Date.now() - start) / 1000;
      console.log(`  Agent (${duration.toFixed(1)}s): ${response.slice(0, 300)}${response.length > 300 ? "..." : ""}\n`);
      turns.push({ role: "user", content: step.say });
      turns.push({ role: "agent", content: response, duration });
    } else {
      const label = step.feedback === "good" ? "/good" : `/bad${step.correction ? ` ${step.correction}` : ""}`;
      console.log(`  [${label}]`);
      const start = Date.now();
      const result = await handleFeedback(session, step.feedback, step.correction);
      const duration = (Date.now() - start) / 1000;
      console.log(`  Result (${duration.toFixed(1)}s): ${result.slice(0, 200)}\n`);
      turns.push({ role: "feedback", content: `${label} → ${result}`, duration });
    }
  }

  session.contextActor.stop();
  conversations.push({ title, description, turns });
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Example Conversations — Self-Improving Memory Palace  ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // ── Conversation 1: Learning from factual correction ──────────────
  await runConversation(
    "Conversation 1: Learning from Factual Correction",
    "Agent gets a fact wrong, gets /bad feedback, then answers correctly on retry.",
    [
      { say: "What year was the first iPhone released?" },
      { say: "I think the first iPhone came out in 2008, right?" },
      { feedback: "bad", correction: "The first iPhone was announced by Steve Jobs on January 9, 2007 and released on June 29, 2007. Not 2008." },
      { say: "When was the first iPhone released?" },
      { feedback: "good" },
    ]
  );

  // ── Conversation 2: Style preference learning ─────────────────────
  await runConversation(
    "Conversation 2: Style Preference Learning",
    "Agent learns the user wants code examples, not prose explanations.",
    [
      { say: "How do I reverse a string in JavaScript?" },
      { feedback: "bad", correction: "Just show me the code. I don't need a paragraph explaining what reversing means." },
      { say: "How do I check if a string is a palindrome in JavaScript?" },
      { feedback: "good" },
      { say: "How do I flatten a nested array in JavaScript?" },
    ]
  );

  // ── Conversation 3: Fact verification in action ───────────────────
  await runConversation(
    "Conversation 3: Fact Verification — Catching False Claims",
    "User makes false claims. Agent verifies and corrects them.",
    [
      { say: "Python is a compiled language like C++, right?" },
      { say: "I read that Elon Musk founded Google." },
      { say: "Thanks for the corrections. What do you remember about our conversation?" },
    ]
  );

  // ── Conversation 4: The agent discusses its own architecture ──────
  await runConversation(
    "Conversation 4: Meta — Agent Discusses Its Own Memory Framework",
    "The agent reflects on how it works, its memory palace architecture, and how it learns.",
    [
      { say: "I built you. You're a self-improving AI agent with a memory palace architecture. Can you explain how your memory system works?" },
      { say: "How does the feedback loop work? When I type /good or /bad, what happens inside you?" },
      { say: "What about your fact verification? How do you decide if something I say is true or false?" },
      { say: "What are your limitations? What could be improved about your architecture?" },
      { feedback: "good" },
    ]
  );

  // ── Conversation 5: Multi-turn context tracking ───────────────────
  await runConversation(
    "Conversation 5: Context Tracking Across Topic Shifts",
    "Tests that the agent tracks topics, loads rooms, and handles shifts.",
    [
      { say: "I'm working on a Rust project that needs to parse JSON. What crate should I use?" },
      { say: "Actually, let's switch topics completely. What's a good recipe for pasta aglio e olio?" },
      { say: "Going back to the Rust project — how do I handle errors with serde?" },
      { say: "What topics have we discussed so far?" },
    ]
  );

  // ── Save all conversations ────────────────────────────────────────
  const output = {
    timestamp: new Date().toISOString(),
    totalConversations: conversations.length,
    conversations,
  };

  const outputPath = "examples/conversations.json";
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  // Also write a readable markdown version
  let md = "# Example Conversations\n\n";
  md += "These conversations demonstrate the self-improving capabilities of the Memory Palace Agent.\n\n";

  for (const conv of conversations) {
    md += `## ${conv.title}\n\n`;
    md += `*${conv.description}*\n\n`;

    for (const turn of conv.turns) {
      if (turn.role === "user") {
        md += `**User:** ${turn.content}\n\n`;
      } else if (turn.role === "agent") {
        md += `**Agent** *(${turn.duration?.toFixed(1)}s):* ${turn.content}\n\n`;
      } else {
        md += `> ${turn.content}\n\n`;
      }
    }
    md += "---\n\n";
  }

  writeFileSync("examples/CONVERSATIONS.md", md);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  All ${conversations.length} conversations complete.`);
  console.log(`  Saved to examples/conversations.json`);
  console.log(`  Saved to examples/CONVERSATIONS.md`);
  console.log(`${"═".repeat(60)}\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
