/**
 * Drives createSupportAgent with a scripted fake streamFn (no network) and
 * proves that the deterministic guards, not the prompt, protect the ledger.
 */


import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import { createSupportAgent, type SupportAgent } from "../src/agent/createAgent";
import { Session } from "../src/domain/session";

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface Step {
  tools?: ScriptedToolCall[];
  text?: string;
  /** Emit toolcall_start, then wait for the abort signal and end the stream as aborted. */
  hangUntilAbort?: boolean;
}

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake",
    usage: USAGE,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function scripted(steps: Step[]) {
  const calls: Context[] = [];
  let callId = 0;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    calls.push(context);
    const signal = options?.signal;
    const abort = () => stream.push({ type: "error", reason: "aborted", error: message([], "aborted", "aborted by user") });

    void (async () => {
      if (signal?.aborted) return abort();
      const step = steps.shift();
      if (!step) return stream.push({ type: "error", reason: "error", error: message([], "error", "script exhausted") });

      const content: AssistantMessage["content"] = [];
      const partial = () => message([...content], "pending");
      stream.push({ type: "start", partial: partial() });
      await tick();

      if (step.text !== undefined) {
        const block: TextContent = { type: "text", text: "" };
        content.push(block);
        const idx = content.length - 1;
        stream.push({ type: "text_start", contentIndex: idx, partial: partial() });
        await tick();
        if (signal?.aborted) return abort();
        block.text = step.text;
        stream.push({ type: "text_delta", contentIndex: idx, delta: step.text, partial: partial() });
        stream.push({ type: "text_end", contentIndex: idx, content: step.text, partial: partial() });
        await tick();
      }

      for (const call of step.tools ?? []) {
        stream.push({ type: "toolcall_start", contentIndex: content.length, partial: partial() });
        if (step.hangUntilAbort) {
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return abort();
        }
        await tick();
        if (signal?.aborted) return abort();
        const toolCall: ToolCall = { type: "toolCall", id: `call-${++callId}`, name: call.name, arguments: call.args };
        content.push(toolCall);
        stream.push({ type: "toolcall_end", contentIndex: content.length - 1, toolCall, partial: partial() });
        await tick();
      }

      const reason = (step.tools?.length ?? 0) > 0 ? "toolUse" : "stop";
      stream.push({ type: "done", reason, message: message([...content], reason) });
    })();

    return stream;
  };

  return { streamFn, calls, remaining: () => steps.length };
}

interface ToolEnd {
  name: string;
  text: string;
  isError: boolean;
}

function recorder() {
  const ends: ToolEnd[] = [];
  const starts: string[] = [];
  const deltas: string[] = [];
  const onEvent = (e: AgentEvent) => {
    if (e.type === "tool_execution_start") starts.push(e.toolName);
    if (e.type === "tool_execution_end") ends.push({ name: e.toolName, text: e.result.content[0].text, isError: e.isError });
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") deltas.push(e.assistantMessageEvent.delta);
  };
  return { ends, starts, deltas, onEvent, reset: () => { ends.length = 0; starts.length = 0; deltas.length = 0; } };
}

export { scripted, recorder };
export type { ScriptedToolCall, Step };
