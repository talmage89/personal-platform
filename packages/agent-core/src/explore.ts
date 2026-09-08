import { aggregateSpan, fetchCalls, fetchTrace, searchDialog } from "./bigquery.ts";
import type { AgentConfig } from "./config.ts";
import type { ToolSpec } from "./openrouter.ts";
import { redact, redactAll } from "./redact.ts";
import type { Window } from "./types.ts";

/**
 * Log tools that carry their own time range.
 *
 * `tools.ts` gives the summariser tools bounded to the window it is reviewing —
 * the range is not an argument, so a summary cannot quietly describe traffic
 * from outside the period it claims to cover. That is exactly right for a
 * summary and exactly wrong for a conversation, where the whole point of asking
 * is that you do not yet know which hour you care about.
 *
 * So these take `since` and `until`. What replaces the fixed window as the
 * safety property is a cap on how much any one call may reach across: the
 * warehouse bills by bytes scanned, and a model that decides to read a quarter
 * one page at a time should hit a wall rather than an invoice.
 */

const DAY_MS = 86_400_000;

/** Aggregates are cheap per row, so they may look back a long way. */
const MAX_AGGREGATE_DAYS = 92;

/** Reading dialog is not, so it may not. */
const MAX_READ_DAYS = 14;

/** Rows per call. The budget is turns, not tokens — see openrouter.ts. */
const MAX_ROWS = 20;

const EXCERPT_CHARS = 2_500;

const iso = (date: Date): string => date.toISOString().slice(0, 16).replace("T", " ");

/**
 * A time from the model, in whatever form it felt like writing one.
 *
 * Relative forms are accepted because they are what a model reaches for when a
 * person says "yesterday", and the alternative is a round trip spent correcting
 * an argument rather than answering the question. Anything unparseable returns
 * null and the caller falls back to its default, which is always a defensible
 * span rather than an error.
 */
export function parseInstant(value: unknown, now: Date): Date | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  if (text.toLowerCase() === "now") return now;

  const relative = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)(?:\s+ago)?$/i.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? "d").toLowerCase();
    const ms = { m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS }[unit] ?? DAY_MS;
    return new Date(now.getTime() - amount * ms);
  }

  // A bare date means the whole of that day in UTC, which is what someone
  // writing "2026-09-03" means and not what `new Date` would otherwise do to it
  // in a non-UTC environment.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00Z`);

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface SpanOptions {
  now: Date;
  defaultDays: number;
  maxDays: number;
}

/** The span a tool call asked for, clamped, plus anything worth saying about it. */
function spanFrom(
  args: Record<string, unknown>,
  { now, defaultDays, maxDays }: SpanOptions,
): { window: Window; note: string } {
  const untilAsked = parseInstant(args.until, now);
  const sinceAsked = parseInstant(args.since, now);

  const end = untilAsked ?? now;
  const start = sinceAsked ?? new Date(end.getTime() - defaultDays * DAY_MS);

  if (start >= end) {
    const fallback = new Date(end.getTime() - defaultDays * DAY_MS);
    return {
      window: { start: fallback, end },
      note: `\n\n(since was not before until, so this covers ${iso(fallback)} to ${iso(end)} UTC instead.)`,
    };
  }

  const span = end.getTime() - start.getTime();
  if (span > maxDays * DAY_MS) {
    const clamped = new Date(end.getTime() - maxDays * DAY_MS);
    return {
      window: { start: clamped, end },
      note: `\n\n(narrowed to the most recent ${maxDays} days, ${iso(clamped)} to ${iso(end)} UTC — one lookup may not reach further back than that. Ask again for an earlier span if you need it.)`,
    };
  }

  return { window: { start, end }, note: "" };
}

const SINCE_UNTIL = {
  since: {
    type: "string",
    description:
      "start of the range: an ISO instant, a date like 2026-09-03, or a relative age like 6h or 3d",
  },
  until: { type: "string", description: "end of the range, same forms. defaults to now" },
} as const;

const money = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/**
 * Reading the trace table over any span, for a conversation rather than a
 * window.
 *
 * `now` is fixed by the caller instead of read from the clock inside each tool,
 * so every lookup in one exchange measures "3d ago" from the same instant. A
 * conversation that drifts as it runs is a conversation whose answers cannot be
 * compared to each other.
 */
export function spanTools(config: AgentConfig, now: Date): ToolSpec[] {
  return [
    {
      name: "activity",
      description:
        "Exact totals for a period, computed in the warehouse: calls, spend, tokens, errors, and the split by model. Cheap and exact at any size — use it before reading anything, and prefer it to counting rows yourself.",
      parameters: { type: "object", properties: { ...SINCE_UNTIL }, required: [] },
      run: async (args) => {
        const { window, note } = spanFrom(args, {
          now,
          defaultDays: 1,
          maxDays: MAX_AGGREGATE_DAYS,
        });
        const totals = await aggregateSpan(config, window);

        if (totals.callCount === 0) {
          return `No calls at all between ${iso(window.start)} and ${iso(window.end)} UTC.${note}`;
        }

        const hours = (window.end.getTime() - window.start.getTime()) / 3_600_000;
        const models = totals.models
          .map((m) => `  ${m.model}: ${m.calls} calls, ${money(m.costUsd)}`)
          .join("\n");

        return [
          `${iso(window.start)} to ${iso(window.end)} UTC (${hours.toFixed(1)}h)`,
          `calls: ${totals.callCount} (${(totals.callCount / hours).toFixed(1)}/hour)`,
          `spend: ${money(totals.costUsd)} (${money(totals.costUsd / hours)}/hour)`,
          `tokens: ${totals.totalTokens.toLocaleString("en-US")}`,
          `errors: ${totals.errorCount}`,
          `median prompt: ${totals.medianPromptTokens.toLocaleString("en-US")} tokens`,
          `models:\n${models}`,
        ]
          .join("\n")
          .concat(note);
      },
    },

    {
      name: "read_calls",
      description:
        "Read the prompts the agent sent during a period, oldest first, a page at a time. Use `offset` to walk forward. The excerpt is the head of the request and then its tail, which is where the most recent turn and its tool results are.",
      parameters: {
        type: "object",
        properties: {
          ...SINCE_UNTIL,
          offset: { type: "integer", minimum: 0, description: "0-based, in time order" },
          limit: { type: "integer", minimum: 1, maximum: MAX_ROWS },
        },
        required: [],
      },
      run: async (args) => {
        const { window, note } = spanFrom(args, { now, defaultDays: 1, maxDays: MAX_READ_DAYS });
        const offset = Math.max(0, Number(args.offset ?? 0) || 0);
        const limit = Math.min(MAX_ROWS, Math.max(1, Number(args.limit ?? 8) || 8));

        const { calls } = await fetchCalls(config, window, { limit, offset });
        if (calls.length === 0) {
          return `No calls at offset ${offset} between ${iso(window.start)} and ${iso(window.end)} UTC. Use activity to see whether the period holds any at all.${note}`;
        }

        const { texts } = redactAll(calls.map((c) => c.inputExcerpt));
        const rendered = calls.map((call, i) =>
          [
            `trace ${call.traceId} · ${call.at.toISOString()} · ${call.model} · ${call.promptTokens} prompt tokens`,
            (texts[i] ?? "").slice(0, EXCERPT_CHARS),
          ].join("\n"),
        );

        return `Calls ${offset}–${offset + calls.length - 1}.\n\n${rendered.join("\n\n---\n\n")}${note}`;
      },
    },

    {
      name: "search_calls",
      description:
        "Find calls in a period whose request contains a piece of text — a hostname, a filename, an error string, a command. Case-insensitive substring, not a regex.",
      parameters: {
        type: "object",
        properties: {
          needle: { type: "string", minLength: 2, description: "text to look for" },
          ...SINCE_UNTIL,
          limit: { type: "integer", minimum: 1, maximum: MAX_ROWS },
        },
        required: ["needle"],
      },
      run: async (args) => {
        const needle = String(args.needle ?? "").trim();
        if (needle.length < 2) return "error: needle must be at least two characters";

        const { window, note } = spanFrom(args, { now, defaultDays: 7, maxDays: MAX_READ_DAYS });
        const limit = Math.min(MAX_ROWS, Math.max(1, Number(args.limit ?? 10) || 10));
        const { hits, truncated } = await searchDialog(config, window, needle, limit);

        if (hits.length === 0) {
          return `Nothing between ${iso(window.start)} and ${iso(window.end)} UTC contains ${JSON.stringify(needle)}.${note}`;
        }

        const { texts } = redactAll(hits.map((h) => h.excerpt));
        const rendered = hits.map((hit, i) =>
          [
            `trace ${hit.traceId} · ${hit.at.toISOString()} · ${hit.model}`,
            (texts[i] ?? "").slice(0, EXCERPT_CHARS),
          ].join("\n"),
        );

        return `${hits.length} match${hits.length === 1 ? "" : "es"}${truncated ? " (more exist)" : ""} for ${JSON.stringify(needle)}.\n\n${rendered.join("\n\n---\n\n")}${note}`;
      },
    },

    {
      name: "read_trace",
      description:
        "Read one whole exchange by trace id, when an excerpt was cut off at the interesting part. Ids come from the other tools. Give the day it happened on — the table is partitioned by date and a lookup without one cannot be answered.",
      parameters: {
        type: "object",
        properties: {
          trace_id: { type: "string", minLength: 1 },
          on: { type: "string", description: "the date the trace is from, e.g. 2026-09-03" },
        },
        required: ["trace_id"],
      },
      run: async (args) => {
        const id = String(args.trace_id ?? "").trim();
        if (!id) return "error: trace_id is required";

        // A day either side of the date given: a trace near midnight is filed
        // under whichever date its timestamp fell on, which is not always the
        // one the caller read off a neighbouring row.
        const on = parseInstant(args.on, now) ?? now;
        const window: Window = {
          start: new Date(on.getTime() - DAY_MS),
          end: new Date(on.getTime() + DAY_MS),
        };

        const body = await fetchTrace(config, window, id);
        if (!body) {
          return `No trace ${id} within a day of ${iso(on)} UTC. If you have its timestamp, pass that date as \`on\`.`;
        }
        return redact(body).text;
      },
    },
  ];
}
