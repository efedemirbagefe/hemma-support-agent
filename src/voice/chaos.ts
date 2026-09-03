/**
 * Demo chaos toggles. They come only from the /ws upgrade URL (`?fail=tool,tts,stt`), never
 * from env, and are off by default.
 *
 * - tool: the first `check_resolution_options` call of the session throws; the second works.
 *   Done by adding `simulateFailure: true` to that call's params, which the domain's own
 *   `maybeFail` hook turns into a thrown error (src/domain is not touched).
 * - tts: every ElevenLabs stream of a turn fails without opening a socket, so the turn's
 *   sentences go through the retry path and then the Deepgram Aura fallback.
 * - stt: the Deepgram listen socket is closed once, right after the first final transcript;
 *   the session's reconnect backoff reopens it on the next audio frame.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";

export type ChaosFlag = "tool" | "tts" | "stt";
export const CHAOS_FLAGS: readonly ChaosFlag[] = ["tool", "tts", "stt"];
/** The tool that fail=tool breaks once per session. */
export const CHAOS_TOOL = "check_resolution_options";

/** `?fail=` value(s): comma separated, case-insensitive; unknown and duplicate flags are dropped. */
export function parseChaos(fail: string | null | undefined): ChaosFlag[] {
  if (!fail) return [];
  const wanted = new Set(
    fail
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return CHAOS_FLAGS.filter((f) => wanted.has(f));
}

export class ChaosState {
  private readonly flags: ReadonlySet<ChaosFlag>;
  private toolFailed = false;
  private sttDropped = false;

  constructor(flags: Iterable<ChaosFlag> = []) {
    this.flags = new Set(flags);
  }

  /** The active flags in canonical order (what the ready event reports). */
  get list(): ChaosFlag[] {
    return CHAOS_FLAGS.filter((f) => this.flags.has(f));
  }

  has(flag: ChaosFlag): boolean {
    return this.flags.has(flag);
  }

  /** True exactly once: for the first CHAOS_TOOL call while fail=tool is set. */
  takeToolFailure(tool: string): boolean {
    if (!this.flags.has("tool") || tool !== CHAOS_TOOL || this.toolFailed) return false;
    this.toolFailed = true;
    return true;
  }

  /** True exactly once: after the first final transcript while fail=stt is set. */
  takeSttDrop(): boolean {
    if (!this.flags.has("stt") || this.sttDropped) return false;
    this.sttDropped = true;
    return true;
  }
}

/** The text the model reads when a tool threw. Same wording as the client's error toast. */
export function toolFailureText(tool: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Tool ${tool} failed: ${message}`;
}

/**
 * Wrap the domain tools for one session. A chaos-selected call gets `simulateFailure: true`
 * added to its params so the domain throws through its own hook, and any exception (chaos or
 * real) is rethrown with a message that names the tool, so the model reads an unambiguous
 * failure text and the harness continues the turn with it.
 */
export function instrumentTools(tools: AgentTool<any>[], chaos: ChaosState): AgentTool<any>[] {
  return tools.map(
    (tool): AgentTool<any> => ({
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const args =
          chaos.takeToolFailure(tool.name) && params && typeof params === "object"
            ? { ...(params as Record<string, unknown>), simulateFailure: true }
            : params;
        try {
          return await tool.execute(toolCallId, args, signal, onUpdate);
        } catch (err) {
          throw new Error(toolFailureText(tool.name, err));
        }
      },
    }),
  );
}
