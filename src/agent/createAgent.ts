import "dotenv/config";
import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { makeAfterToolCall, makeBeforeToolCall } from "../domain/guards";
import type { Session } from "../domain/session";
import { createTools } from "../domain/tools";
import { buildSystemPrompt } from "./prompt";
import { sanitizeSpoken } from "./speech";

export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";
export const FALLBACK_MODEL_ID = "claude-haiku-4-5";

export interface SupportAgentOptions {
  session: Session;
  modelId?: string;
  streamFn?: StreamFn;
  model?: Model<any>;
  onEvent?: (e: AgentEvent) => void;
}

export interface SupportAgent {
  agent: Agent;
  sendUserText(text: string): Promise<void>;
  abort(): void;
  isBusy(): boolean;
}

/** Minimal model object for injected stream functions (tests). */
export function stubModel(id = "fake-model"): Model<any> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

/**
 * Text deltas reach subscribers with spoken-text hygiene applied (no dashes). The agent's
 * own message history is untouched; only what is spoken or shown changes.
 */
export function spokenEvent(e: AgentEvent): AgentEvent {
  if (e.type !== "message_update" || e.assistantMessageEvent.type !== "text_delta") return e;
  const delta = e.assistantMessageEvent.delta;
  const clean = sanitizeSpoken(delta);
  if (clean === delta) return e;
  return { ...e, assistantMessageEvent: { ...e.assistantMessageEvent, delta: clean } };
}

export function createSupportAgent(opts: SupportAgentOptions): SupportAgent {
  const { session } = opts;
  let model = opts.model;
  let streamFn = opts.streamFn;
  let getApiKey: ((provider: string) => string | undefined) | undefined;

  if (streamFn && !model) {
    model = stubModel(opts.modelId);
  } else if (!streamFn) {
    const models = createModels();
    models.setProvider(anthropicProvider());
    if (!model) {
      const wanted = opts.modelId ?? DEFAULT_MODEL_ID;
      model = models.getModel("anthropic", wanted) ?? models.getModel("anthropic", FALLBACK_MODEL_ID);
      if (!model) throw new Error(`Model not found: ${wanted} (fallback ${FALLBACK_MODEL_ID} also missing)`);
    }
    streamFn = models.streamSimple.bind(models);
    getApiKey = () => process.env.ANTHROPIC_API_KEY;
  }

  const agent = new Agent({
    initialState: { systemPrompt: buildSystemPrompt(session), model, tools: createTools(session) },
    streamFn: streamFn!,
    getApiKey,
    beforeToolCall: makeBeforeToolCall(session),
    afterToolCall: makeAfterToolCall(session),
    // Refresh the live state block between turns inside one run (after tool calls).
    prepareNextTurnWithContext: (ctx) => ({ context: { ...ctx.context, systemPrompt: buildSystemPrompt(session) } }),
    toolExecution: "sequential",
  });

  if (opts.onEvent) {
    const onEvent = opts.onEvent;
    agent.subscribe((e) => {
      onEvent(spokenEvent(e));
    });
  }

  // Utterances are serialised: the next one is recorded on the session only once the
  // previous turn is over, so a running turn can never see a yes the customer gave later.
  let queue: Promise<void> = Promise.resolve();

  return {
    agent,
    sendUserText(text: string) {
      const run = async () => {
        while (agent.state.isStreaming) await agent.waitForIdle();
        session.setLastUserUtterance(text);
        agent.state.systemPrompt = buildSystemPrompt(session);
        await agent.prompt(text);
      };
      const next = queue.then(run);
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    abort() {
      agent.abort();
    },
    isBusy() {
      return agent.state.isStreaming;
    },
  };
}
