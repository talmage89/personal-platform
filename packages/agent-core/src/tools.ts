import { fetchTrace, searchDialog } from "./bigquery.ts";
import type { AgentConfig } from "./config.ts";
import type { ToolSpec } from "./openrouter.ts";
import { redact, redactAll } from "./redact.ts";
import type { Call, Window } from "./types.ts";

/**
 * What the summariser is allowed to go and look at.
 *
 * The fixed sample answers "what was this hour about". These answer the
 * follow-up question — the one a person would ask after reading it — without
 * putting the whole window in the prompt. Every result passes through the
 * redactor on the way back, because a tool result is prompt material like any
 * other and the model has no way to know a string is a credential.
 *
 * Each tool is bounded by construction: the window is fixed by the caller and
 * is not an argument, so nothing here can read outside the period under review.
 */

/** Per-tool-call cap on returned dialog. The budget is turns, not tokens. */
const MAX_RETURNED = 25;
const EXCERPT_CHARS = 3_000;

function renderCall(call: Call, body: string): string {
  return [
    `trace ${call.traceId} · ${call.at.toISOString()} · ${call.model}`,
    `${call.promptTokens} prompt tokens, ${call.completionTokens} completion${
      call.finishReason ? `, finished: ${call.finishReason}` : ""
    }`,
    body.slice(0, EXCERPT_CHARS),
  ].join("\n");
}

/**
 * Tools over the calls already loaded for this window, plus two that go back to
 * the table.
 *
 * `read_dialog` is deliberately served from memory: the window's calls were
 * fetched once to compute the arithmetic, so paging through them costs nothing
 * and the model is not billed a query to re-read what is already here.
 */
export function logTools(config: AgentConfig, window: Window, calls: Call[]): ToolSpec[] {
  return [
    {
      name: "read_dialog",
      description:
        "Read the prompts sent during this window, in time order, by position. Use it to see more than the sample when the sample is not enough. Returns at most 12 at a time.",
      parameters: {
        type: "object",
        properties: {
          offset: { type: "integer", description: "0-based position in the window", minimum: 0 },
          limit: {
            type: "integer",
            description: "how many to return, 1-25",
            minimum: 1,
            maximum: MAX_RETURNED,
          },
        },
        required: ["offset"],
      },
      run: async (args) => {
        const offset = Math.max(0, Number(args.offset ?? 0) || 0);
        const limit = Math.min(MAX_RETURNED, Math.max(1, Number(args.limit ?? 5) || 5));
        const slice = calls.slice(offset, offset + limit);

        if (slice.length === 0) {
          return `No calls at offset ${offset}. The window holds ${calls.length}.`;
        }

        const { texts } = redactAll(slice.map((c) => c.inputExcerpt));
        const rendered = slice.map((call, i) => renderCall(call, texts[i] ?? ""));
        return `Calls ${offset}–${offset + slice.length - 1} of ${calls.length}.\n\n${rendered.join("\n\n---\n\n")}`;
      },
    },

    {
      name: "search_dialog",
      description:
        "Find calls in this window whose request contains a piece of text — a hostname, a filename, an error string, a command. Case-insensitive substring match, not a regex.",
      parameters: {
        type: "object",
        properties: {
          needle: { type: "string", description: "text to look for", minLength: 2 },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
        required: ["needle"],
      },
      run: async (args) => {
        const needle = String(args.needle ?? "").trim();
        if (needle.length < 2) return "error: needle must be at least two characters";

        const { hits, truncated } = await searchDialog(
          config,
          window,
          needle,
          Number(args.limit ?? 10) || 10,
        );

        if (hits.length === 0) return `No calls in this window contain ${JSON.stringify(needle)}.`;

        const { texts } = redactAll(hits.map((h) => h.excerpt));
        const rendered = hits.map((hit, i) =>
          [
            `trace ${hit.traceId} · ${hit.at.toISOString()} · ${hit.model}`,
            (texts[i] ?? "").slice(0, EXCERPT_CHARS),
          ].join("\n"),
        );

        return `${hits.length} match${hits.length === 1 ? "" : "es"}${truncated ? " (more exist)" : ""} for ${JSON.stringify(needle)}.\n\n${rendered.join("\n\n---\n\n")}`;
      },
    },

    {
      name: "read_trace",
      description:
        "Read one whole trace by id, when an excerpt was cut off at the interesting part. Ids come from the other tools.",
      parameters: {
        type: "object",
        properties: { trace_id: { type: "string", minLength: 1 } },
        required: ["trace_id"],
      },
      run: async (args) => {
        const id = String(args.trace_id ?? "").trim();
        if (!id) return "error: trace_id is required";

        const body = await fetchTrace(config, window, id);
        if (!body) return `No trace ${id} in this window.`;
        return redact(body).text;
      },
    },
  ];
}
