import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import ora from "ora";
import {
  initSession,
  handleMessageStream,
  handleFeedbackBackground,
} from "./agent/agent.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const CLEAR_LINE = "\x1b[2K\r";
const width = Math.min(process.stdout.columns || 80, 100);
const line = chalk.dim("─".repeat(width));

// ─── Banner ──────────────────────────────────────────────────────────────────

function showBanner() {
  console.log();
  console.log(chalk.bold.hex("#a78bfa")("  ◆ Memory Palace Agent"));
  console.log(
    chalk.dim(
      "  Self-improving AI with persistent memory, fact verification & learning"
    )
  );
  console.log();
  console.log(line);
  console.log();
  console.log(
    chalk.dim("  Commands:  ") +
      chalk.white("/good") +
      chalk.dim(" · ") +
      chalk.white("/bad [correction]") +
      chalk.dim(" · ") +
      chalk.white("/rooms") +
      chalk.dim(" · ") +
      chalk.white("/quit")
  );
  console.log();
}

// ─── Format Tool Call ────────────────────────────────────────────────────────

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>
): string {
  const icons: Record<string, string> = {
    searchMemory: "🔍",
    storeMemory: "💾",
    searchWebTool: "🌐",
    queryKnowledge: "🧠",
    listPalace: "🏛️",
    storeKnowledge: "📝",
  };
  const icon = icons[toolName] ?? "⚡";

  const argParts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${chalk.dim(k + "=")}${chalk.white(val.length > 35 ? val.slice(0, 35) + "…" : val)}`;
    })
    .join(chalk.dim(", "));

  return `  ${icon} ${chalk.hex("#a78bfa")(toolName)}${argParts ? chalk.dim("(") + argParts + chalk.dim(")") : ""}`;
}

function formatToolResult(toolName: string): string {
  return `  ${chalk.green("✓")} ${chalk.dim(toolName + " done")}`;
}

// ─── Format Rooms ────────────────────────────────────────────────────────────

function formatRooms(
  rooms: Array<{
    wing: string;
    room: string;
    relevance: number;
    tokenCount: number;
  }>
) {
  if (rooms.length === 0) {
    console.log(chalk.dim("\n  No active rooms.\n"));
    return;
  }

  console.log(chalk.bold("\n  Active Rooms\n"));

  for (const room of rooms.sort((a, b) => b.relevance - a.relevance)) {
    const bar = "█".repeat(Math.round(room.relevance * 10));
    const empty = "░".repeat(10 - Math.round(room.relevance * 10));
    const color =
      room.relevance > 0.6
        ? chalk.green
        : room.relevance > 0.3
          ? chalk.yellow
          : chalk.red;

    console.log(
      `  ${color(bar + empty)} ${chalk.white(room.wing + "/" + room.room)} ${chalk.dim(`${(room.relevance * 100).toFixed(0)}% · ${room.tokenCount} tokens`)}`
    );
  }
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  showBanner();

  const spinner = ora({
    text: "Starting session...",
    color: "magenta",
  }).start();

  const session = await initSession();
  spinner.succeed(
    chalk.dim(`Session ready · ${session.userId.slice(0, 8)}…`)
  );
  console.log();

  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    let input: string;
    try {
      input = await rl.question(chalk.bold.cyan("❯ "));
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    // ── Commands ──────────────────────────────────────────────────

    if (trimmed === "/quit" || trimmed === "/exit") {
      console.log(chalk.dim("\n  Goodbye.\n"));
      break;
    }

    if (trimmed === "/rooms") {
      const snapshot = session.contextActor.getSnapshot();
      formatRooms(snapshot.context.activeRooms);
      continue;
    }

    if (trimmed === "/good") {
      const result = handleFeedbackBackground(session, "good");
      console.log(
        `\n  ${chalk.green("▲")} ${chalk.dim(result)}\n`
      );
      continue;
    }

    if (trimmed.startsWith("/bad")) {
      const correction = trimmed.slice("/bad".length).trim() || undefined;
      const result = handleFeedbackBackground(session, "bad", correction);
      console.log(
        `\n  ${chalk.red("▼")} ${chalk.dim(result)}\n`
      );
      continue;
    }

    if (trimmed.startsWith("/")) {
      console.log(
        chalk.dim(`\n  Unknown command: ${trimmed}. Try /good, /bad, /rooms, or /quit.\n`)
      );
      continue;
    }

    // ── Message ──────────────────────────────────────────────────

    try {
      const thinkSpinner = ora({
        text: chalk.dim("Thinking…"),
        color: "magenta",
        indent: 2,
      }).start();

      let firstToken = true;
      let toolsUsed = 0;

      await handleMessageStream(session, trimmed, {
        onText: (delta) => {
          if (firstToken) {
            thinkSpinner.stop();
            process.stdout.write(CLEAR_LINE);
            process.stdout.write(`\n  `);
            firstToken = false;
          }
          // Indent continuation lines
          const indented = delta.replace(/\n/g, "\n  ");
          process.stdout.write(indented);
        },
        onToolCall: (toolName, args) => {
          if (firstToken) {
            thinkSpinner.stop();
            process.stdout.write(CLEAR_LINE);
            firstToken = false;
          }
          toolsUsed++;
          console.log(formatToolCall(toolName, args));
        },
        onToolResult: (toolName) => {
          console.log(formatToolResult(toolName));
        },
        onDone: () => {
          console.log("\n");
          if (toolsUsed > 0) {
            console.log(
              chalk.dim(`  ${toolsUsed} tool${toolsUsed > 1 ? "s" : ""} used`)
            );
            console.log();
          }
        },
      });
    } catch (err) {
      process.stdout.write(CLEAR_LINE);
      console.error(
        chalk.red(
          `\n  Error: ${err instanceof Error ? err.message : err}\n`
        )
      );
    }
  }

  rl.close();
  session.contextActor.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
