import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  initSession,
  handleMessageStream,
  handleFeedbackBackground,
} from "./agent/agent.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

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
      input = await rl.question(`${CYAN}You:${RESET} `);
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
        console.log("\n  [No active rooms]\n");
      } else {
        console.log("\n  Active rooms:");
        for (const room of rooms) {
          console.log(
            `    ${room.wing}/${room.room} — relevance: ${room.relevance.toFixed(2)}, tokens: ${room.tokenCount}`
          );
        }
        console.log();
      }
      continue;
    }

    if (trimmed === "/good") {
      const result = handleFeedbackBackground(session, "good");
      console.log(`\n  ${GREEN}${result}${RESET}\n`);
      continue;
    }

    if (trimmed.startsWith("/bad")) {
      const correction = trimmed.slice("/bad".length).trim() || undefined;
      const result = handleFeedbackBackground(session, "bad", correction);
      console.log(`\n  ${GREEN}${result}${RESET}\n`);
      continue;
    }

    try {
      // Show thinking indicator
      process.stdout.write(`\n${DIM}[thinking...]${RESET}`);

      let firstToken = true;
      await handleMessageStream(session, trimmed, {
        onText: (delta) => {
          if (firstToken) {
            // Clear the thinking indicator and start agent output
            process.stdout.write(`\r${YELLOW}Agent:${RESET} `);
            firstToken = false;
          }
          process.stdout.write(delta);
        },
        onToolCall: (toolName, args) => {
          if (firstToken) {
            process.stdout.write(`\r`);
            firstToken = false;
          }
          const argsStr = Object.entries(args as Record<string, unknown>)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 40) : v}`)
            .join(", ");
          process.stdout.write(
            `\n  ${DIM}🔧 ${toolName}(${argsStr})${RESET}\n`
          );
        },
        onToolResult: (toolName, _result) => {
          process.stdout.write(
            `  ${DIM}✓ ${toolName} done${RESET}\n`
          );
        },
        onDone: () => {
          process.stdout.write("\n\n");
        },
      });
    } catch (err) {
      process.stdout.write("\r");
      console.error(
        `\n[Error] ${err instanceof Error ? err.message : err}\n`
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
