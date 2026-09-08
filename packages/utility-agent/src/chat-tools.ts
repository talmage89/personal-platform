import { parseInstant, type ToolSpec } from "@platform/agent-core";
import { formatCost, formatWindow } from "./format.ts";
import {
  deleteNote,
  MAX_NOTE_BODY_CHARS,
  MAX_NOTE_SUMMARY_CHARS,
  noteByKey,
  saveNote,
  summariesBetween,
  summaryById,
} from "./repository.ts";

/**
 * The half of the chat's toolbox that lives in Postgres.
 *
 * Split from the warehouse tools in agent-core for the reason nothing above
 * repository.ts imports `db`: agent-core is the part that knows how to read
 * logs and talk to a model, and giving it a database dependency would mean the
 * package that runs inside a job also had to know how the website stores
 * things. So the log tools are built there, these are built here, and `ask`
 * takes the second lot as an argument.
 */

/** Summaries listed at once. Enough for a fortnight of hours, in one page. */
const MAX_SUMMARIES = 60;

/** Of the narrative, in a list. The id is there to read the rest. */
const CLIP_CHARS = 160;

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= CLIP_CHARS ? flat : `${flat.slice(0, CLIP_CHARS).replace(/\s\S*$/, "")}…`;
};

export interface ChatToolOptions {
  /** Fixed by the caller so every relative range in one answer agrees. */
  now: Date;
  /** Recorded on any note written, so a claim can be traced to its conversation. */
  chatId: string;
}

export function chatTools({ now, chatId }: ChatToolOptions): ToolSpec[] {
  return [
    {
      name: "list_summaries",
      description:
        "List the summaries already written for a period — one line each, newest first, with the id needed to read one in full. These are free to read and cover the record hour by hour, so start here before querying the warehouse.",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "ISO instant, a date, or a relative age like 7d" },
          until: { type: "string", description: "same forms; defaults to now" },
          limit: { type: "integer", minimum: 1, maximum: MAX_SUMMARIES },
        },
        required: [],
      },
      run: async (args) => {
        const end = parseInstant(args.until, now) ?? now;
        const start = parseInstant(args.since, now) ?? new Date(end.getTime() - 7 * 86_400_000);
        const limit = Math.min(MAX_SUMMARIES, Math.max(1, Number(args.limit ?? 24) || 24));

        const rows = await summariesBetween(start, end, limit);
        if (rows.length === 0) {
          return `No summaries cover ${start.toISOString()} to ${end.toISOString()}. That may mean the summariser was not running then — the warehouse tools still reach that period.`;
        }

        const lines = rows.map((row) => {
          const flags = row.flags.map((f) => f.code).join(",");
          return [
            `${row.id} · ${formatWindow(row.periodStart, row.periodEnd)}${row.kind === "manual" ? " · on demand" : ""}`,
            `  ${row.callCount} calls · ${formatCost(row.costUsd)}${flags ? ` · flags: ${flags}` : ""}`,
            `  ${clip(row.narrative)}`,
          ].join("\n");
        });

        return `${rows.length} summaries.\n\n${lines.join("\n\n")}`;
      },
    },

    {
      name: "read_summary",
      description:
        "Read one stored summary in full by its id: the narrative, its flags, and what the summariser looked at while writing it.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
      },
      run: async (args) => {
        const summary = await summaryById(String(args.id ?? "").trim());
        if (!summary) return "No summary with that id.";

        const flags =
          summary.flags.length === 0
            ? "flags: none"
            : `flags:\n${summary.flags.map((f) => `  - [${f.severity}] ${f.code}: ${f.detail}`).join("\n")}`;

        const looked =
          summary.investigation.length === 0
            ? ""
            : `\n\nwhile writing it, the summariser read: ${summary.investigation.map((i) => i.name).join(", ")}`;

        return (
          [
            `${formatWindow(summary.periodStart, summary.periodEnd)} · ${summary.kind}`,
            `${summary.callCount} calls · ${formatCost(summary.costUsd)} · ${summary.errorCount} errors`,
            `models: ${summary.models.map((m) => `${m.model} ×${m.calls}`).join(", ") || "(none)"}`,
            flags,
            "",
            summary.narrative,
          ].join("\n") + looked
        );
      },
    },

    {
      name: "read_note",
      description:
        "Read one of your own notes in full, by its key. The one-line summaries you were shown are only the index.",
      parameters: {
        type: "object",
        properties: { key: { type: "string", minLength: 1 } },
        required: ["key"],
      },
      run: async (args) => {
        const note = await noteByKey(String(args.key ?? "").trim());
        if (!note)
          return "No note with that key. The index in your instructions lists the ones that exist.";
        return `${note.key} (last written ${note.updatedAt.toISOString().slice(0, 10)})\n${note.summary}\n\n${note.body}`;
      },
    },

    {
      name: "remember",
      description:
        "Write a note that survives this conversation. Use it for something durable you had to work to establish — what this agent is for, what its ordinary day costs, a pattern already explained, a correction you were given. Reusing an existing key replaces that note, which is how you correct one rather than accumulating near-duplicates. Not for anything specific to this one question, and not for anything you have not verified.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "a stable handle, lowercase with hyphens, e.g. what-the-agent-works-on",
            minLength: 2,
          },
          summary: {
            type: "string",
            description:
              "one line, carrying the fact itself rather than a description of it — this is what you will see in every future conversation",
            maxLength: MAX_NOTE_SUMMARY_CHARS,
          },
          body: {
            type: "string",
            description: "the detail, and how you established it",
            maxLength: MAX_NOTE_BODY_CHARS,
          },
        },
        required: ["key", "summary", "body"],
      },
      run: async (args) => {
        const summary = String(args.summary ?? "").trim();
        const body = String(args.body ?? "").trim();
        if (!summary) return "error: summary is required — it is the line you will see next time";

        const key = await saveNote({
          key: String(args.key ?? ""),
          summary,
          body: body || summary,
          sourceChatId: chatId,
        });

        return key ? `Noted as ${key}.` : "error: key must contain at least one letter or digit";
      },
    },

    {
      name: "forget",
      description:
        "Delete one of your notes, by key. Use it when a note has turned out to be wrong rather than merely out of date — a note that is only stale should be rewritten with `remember` under the same key.",
      parameters: {
        type: "object",
        properties: { key: { type: "string", minLength: 1 } },
        required: ["key"],
      },
      run: async (args) => {
        await deleteNote(String(args.key ?? ""));
        return "Forgotten.";
      },
    },
  ];
}
