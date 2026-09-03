/**
 * Terminal text chat against the real model.
 *   npx tsx scripts/chat.ts            (needs ANTHROPIC_API_KEY in .env)
 *   NOW=2026-09-08 npx tsx scripts/chat.ts
 *   MODEL_ID=claude-haiku-4-5 npx tsx scripts/chat.ts
 * Commands: /state, /reset, exit
 */
import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createSupportAgent } from "../src/agent/createAgent";
import { isoDate, today, weekdayName } from "../src/domain/clock";
import { Session } from "../src/domain/session";

function short(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function printState(session: Session): void {
  const s = session.snapshot();
  const lines = [
    `customer: ${s.customer ? `${s.customer.name} (${s.customer.ref}, ${s.customer.tier})` : "none"}`,
    `active order: ${s.activeOrderId ?? "none"}`,
    `pending: ${s.pending ? `${s.pending.summary} [${s.pending.key}]` : "none"}`,
    `applied: ${s.applied.length ? s.applied.map((a) => `${a.receipt} ${a.summary ?? a.type}`).join(" | ") : "none"}`,
    `cases: ${s.cases.length ? s.cases.map((c) => `${c.id} ${c.orderId}: ${c.reason}`).join(" | ") : "none"}`,
    `tool log: ${s.toolLog.length ? s.toolLog.map((l) => `${l.tool} ${l.blocked ? "BLOCKED" : l.ok ? "ok" : "error"} ${l.ms}ms`).join(", ") : "empty"}`,
  ];
  console.log(`\n[state]\n  ${lines.join("\n  ")}`);
}

async function main(): Promise<void> {
  const session = new Session();
  let textOnLine = false;
  const sa = createSupportAgent({
    session,
    modelId: process.env.MODEL_ID,
    onEvent: (e) => {
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
        if (!textOnLine) {
          stdout.write("agent> ");
          textOnLine = true;
        }
        stdout.write(e.assistantMessageEvent.delta);
      } else if (e.type === "tool_execution_start") {
        if (textOnLine) stdout.write("\n");
        textOnLine = false;
        console.log(`[tool ${e.toolName}] args ${JSON.stringify(e.args)}`);
      } else if (e.type === "tool_execution_end") {
        const text = e.result?.content?.[0]?.text ?? JSON.stringify(e.result);
        console.log(`[tool ${e.toolName}] ${e.isError ? "BLOCKED/ERROR" : "ok"} ${short(String(text))}`);
      }
    },
  });

  const now = today();
  console.log(`Hemma support chat. Today: ${weekdayName(now)} ${isoDate(now)}${process.env.NOW ? " (NOW override)" : ""}. Model: ${sa.agent.state.model.id}.`);
  console.log("Try: 'Hi, Anna Weber, HM-2201, I want to move my sofa cover delivery to Friday afternoon.' Commands: /state, /reset, exit.\n");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on("close", () => {
    console.log("\nbye");
    process.exit(0);
  });

  while (true) {
    const line = (await rl.question("you> ")).trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") break;
    if (line === "/state") {
      printState(session);
      continue;
    }
    if (line === "/reset") {
      if (sa.isBusy()) {
        sa.abort();
        await sa.agent.waitForIdle();
      }
      session.reset();
      sa.agent.reset();
      console.log("[session reset]");
      continue;
    }
    textOnLine = false;
    const t0 = Date.now();
    try {
      await sa.sendUserText(line);
    } catch (err) {
      console.error(`[error] ${err instanceof Error ? err.message : String(err)}`);
    }
    if (textOnLine) stdout.write("\n");
    if (sa.agent.state.errorMessage) console.log(`[model error] ${sa.agent.state.errorMessage}`);
    console.log(`[turn ${Date.now() - t0}ms]`);
    printState(session);
    console.log("");
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
