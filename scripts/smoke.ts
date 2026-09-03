import "dotenv/config";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Type } from "@sinclair/typebox";

const models = createModels();
models.setProvider(anthropicProvider());
const id = process.argv[2] ?? "claude-sonnet-4-6";
const model = models.getModel("anthropic", id);
if (!model) throw new Error("model not found: " + id);

const t0 = Date.now(); let firstTok = 0;
const agent = new Agent({
  initialState: {
    systemPrompt: "You are terse. Use the tool when asked about weather.",
    model,
    tools: [{
      name: "get_weather", label: "Weather", description: "Weather for a city",
      parameters: Type.Object({ city: Type.String() }),
      execute: async (_id, p) => ({ content: [{ type: "text", text: `Sunny in ${(p as { city: string }).city}, 22C` }], details: {} }),
    }],
  },
  streamFn: models.streamSimple.bind(models),
});
agent.subscribe((e) => {
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") { if (!firstTok) firstTok = Date.now() - t0; process.stdout.write(e.assistantMessageEvent.delta); }
  if (e.type === "tool_execution_start") console.log(`\n[tool ${e.toolName}]`, JSON.stringify(e.args));
});
await agent.prompt("What's the weather in Berlin? One sentence.");
console.log(`\n-- first token ${firstTok}ms, total ${Date.now() - t0}ms, messages ${agent.state.messages.length}`);
console.log("error:", agent.state.errorMessage);
console.log(JSON.stringify(agent.state.messages.map(m => ({ role: (m as any).role, content: (m as any).content })), null, 1).slice(0, 1500));
