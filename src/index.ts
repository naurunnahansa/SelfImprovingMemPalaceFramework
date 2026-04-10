import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  initSession,
  handleMessage,
  handleFeedbackBackground,
} from "./agent/agent.js";

async function main() {
  console.log("=== Memory Palace Agent ===");
  console.log("Commands:");
  console.log("  /good                   — Mark last response as good (learns in background)");
  console.log("  /bad [correction]       — Mark last response as bad (researches + corrects in background)");
  console.log("  /rooms                  — Show active palace rooms");
  console.log("  /quit                   — Exit\n");

  const session = await initSession();
  console.log(`Session started. User: ${session.userId}\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    let input: string;
    try {
      input = await rl.question("You: ");
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed === "/quit") {
      console.log("Goodbye.");
      break;
    }

    if (trimmed === "/rooms") {
      const snapshot = session.contextActor.getSnapshot();
      const rooms = snapshot.context.activeRooms;
      if (rooms.length === 0) {
        console.log("\n[No active rooms]\n");
      } else {
        console.log("\nActive rooms:");
        for (const room of rooms) {
          console.log(
            `  ${room.wing}/${room.room} — relevance: ${room.relevance.toFixed(2)}, tokens: ${room.tokenCount}`
          );
        }
        console.log();
      }
      continue;
    }

    if (trimmed === "/good") {
      const result = handleFeedbackBackground(session, "good");
      console.log(`\n${result}\n`);
      continue;
    }

    if (trimmed.startsWith("/bad")) {
      const correction = trimmed.slice("/bad".length).trim() || undefined;
      const result = handleFeedbackBackground(session, "bad", correction);
      console.log(`\n${result}\n`);
      continue;
    }

    try {
      const response = await handleMessage(session, trimmed);
      console.log(`\nAgent: ${response}\n`);
    } catch (err) {
      console.error(
        "\n[Error]",
        err instanceof Error ? err.message : err,
        "\n"
      );
    }
  }

  rl.close();
  session.contextActor.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
