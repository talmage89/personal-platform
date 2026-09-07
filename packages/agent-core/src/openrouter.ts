import type { AgentConfig } from "./config.ts";

/**
 * A small OpenRouter client, spoken over its OpenAI-compatible endpoint.
 *
 * No SDK, for the same reason the BigQuery client has none: this needs one POST
 * shape and a loop, and the alternative is a dependency tree in a 43 MB image.
 * Using OpenRouter rather than a single vendor also means the summariser can be
 * pointed at whatever is cheap this month by changing an environment variable.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Ceiling on one exchange, tool round-trips included. */
const REQUEST_TIMEOUT_MS = 300_000;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Kept small — models follow small schemas. */
  parameters: Record<string, unknown>;
  /** Returns whatever the model should see. Errors are reported, never thrown. */
  run: (args: Record<string, unknown>) => Promise<string>;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface Choice {
  message?: { content?: string | null; tool_calls?: ToolCall[]; refusal?: string | null };
  finish_reason?: string;
}

interface Completion {
  choices?: Choice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  tools?: ToolSpec[];
  /** Zero disables tool use even when tools are supplied. */
  maxToolCalls?: number;
  /** Wall-clock ceiling for the whole exchange. Serverless runs are bounded. */
  deadline?: Date;
}

export interface ChatResult {
  text: string;
  /** What the model actually looked at. Recorded so a summary is auditable. */
  toolCalls: { name: string; args: string; ok: boolean }[];
  costUsd: number;
  /** Set when the loop stopped for a reason other than the model finishing. */
  stoppedEarly: string | null;
}

async function post(config: AgentConfig, body: unknown, signal: AbortSignal): Promise<Completion> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new OpenRouterError(`${res.status} ${(await res.text()).slice(0, 400)}`, res.status);
  }

  const json = (await res.json()) as Completion;
  // OpenRouter reports some upstream failures as a 200 with an error body.
  if (json.error) throw new OpenRouterError(json.error.message ?? "upstream error");
  return json;
}

/**
 * One exchange, including any tool round-trips the model asks for.
 *
 * The loop is bounded three ways — call count, wall clock, and the request
 * timeout — because this runs unattended on a schedule and a model that decides
 * to read the entire day one page at a time is a cost incident, not a feature.
 * Hitting a bound is reported in `stoppedEarly` rather than thrown: a summary
 * written from partial evidence is worth more than no summary at all, and the
 * arithmetic that surrounds it was never in doubt.
 */
export async function chat(config: AgentConfig, options: ChatOptions): Promise<ChatResult> {
  const { model, system, user, maxTokens, tools = [], maxToolCalls = 0, deadline } = options;

  const messages: Message[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const usable = maxToolCalls > 0 ? tools : [];
  const schema = usable.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

  const performed: ChatResult["toolCalls"] = [];
  let costUsd = 0;
  let stoppedEarly: string | null = null;

  /**
   * Once set, the model is asked one final time with no tools attached, so a
   * run that hit a bound still produces prose instead of nothing. Every exit
   * from the loop below goes through a turn that can return text.
   */
  let forceFinish = false;
  let finalAsked = false;

  // Each round is at most one tool batch, so this only bites if the model
  // asks for a single tool at a time. It exists so the loop cannot spin.
  const maxRounds = maxToolCalls + 2;

  for (let round = 0; round < maxRounds; round++) {
    if (!forceFinish && deadline && Date.now() > deadline.getTime()) {
      stoppedEarly = "ran out of time";
      forceFinish = true;
    }

    const offerTools = !forceFinish && schema.length > 0 && performed.length < maxToolCalls;

    // Withholding the tools is not enough on its own. Asked again with nothing
    // to call, the model tended to narrate what it *would* look at next — which
    // then got stored as the summary — or to return nothing at all. It has to be
    // told, in words, that this turn is the write-up.
    if (forceFinish && !finalAsked) {
      finalAsked = true;
      messages.push({
        role: "user",
        content:
          "You have no lookups left. Write the briefing now, using only what you already have. Do not describe what you would examine next, do not ask for anything further, and do not mention the tools. If the evidence left a flag unexplained, say so plainly and say what you did establish.",
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let completion: Completion;
    try {
      completion = await post(
        config,
        {
          model,
          messages,
          max_tokens: maxTokens,
          // Tagged so the reader can exclude this call from the traces it
          // summarises — see AGENT_SELF_MARKER.
          user: config.AGENT_SELF_MARKER,
          usage: { include: true },
          ...(offerTools ? { tools: schema } : {}),
        },
        controller.signal,
      );
    } catch (error) {
      // An aborted fetch throws a DOMException, not an OpenRouterError, so
      // without this it escaped the degradation path in narrate.ts entirely and
      // took the whole run down — losing the arithmetic along with the prose,
      // which is the one outcome the error handling exists to prevent. A
      // timeout is reported the same way a 500 is.
      if (error instanceof Error && error.name === "AbortError") {
        throw new OpenRouterError(`request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    costUsd += completion.usage?.cost ?? 0;

    const choice = completion.choices?.[0];
    if (choice?.message?.refusal) {
      return {
        text: "The model declined to summarise this window. The statistics above still stand.",
        toolCalls: performed,
        costUsd,
        stoppedEarly: "refused",
      };
    }

    const calls = choice?.message?.tool_calls ?? [];
    const text = (choice?.message?.content ?? "").trim();

    // Either the model is done, or it asked for tools on the turn where they
    // were withheld — in which case what it wrote is all there is going to be.
    if (calls.length === 0 || forceFinish) {
      return { text, toolCalls: performed, costUsd, stoppedEarly };
    }

    // The assistant turn is replayed verbatim, tool calls included, or the tool
    // results below have nothing to attach to.
    messages.push({
      role: "assistant",
      content: choice?.message?.content ?? null,
      tool_calls: calls,
    });

    for (const call of calls) {
      const tool = usable.find((t) => t.name === call.function.name);
      const rawArgs = call.function.arguments || "{}";

      let result: string;
      let ok = true;
      try {
        if (!tool) throw new Error(`no such tool: ${call.function.name}`);
        result = await tool.run(JSON.parse(rawArgs) as Record<string, unknown>);
      } catch (error) {
        // Handed back to the model rather than thrown. A malformed argument is
        // something it can correct on the next turn; killing the run over one
        // would lose the whole window's narrative.
        ok = false;
        result = `error: ${error instanceof Error ? error.message : String(error)}`;
      }

      performed.push({ name: call.function.name, args: rawArgs.slice(0, 300), ok });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }

    if (performed.length >= maxToolCalls) {
      stoppedEarly ??= "reached the tool-call budget";
      forceFinish = true;
    }
  }

  // Only reachable if the model asked for tools on every round and still had
  // budget left, which the round cap makes vanishingly unlikely.
  return {
    text: "",
    toolCalls: performed,
    costUsd,
    stoppedEarly: stoppedEarly ?? "ran out of rounds",
  };
}
