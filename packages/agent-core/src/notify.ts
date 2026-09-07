import type { AgentConfig } from "./config.ts";
import type { ToolSpec } from "./openrouter.ts";
import { redact } from "./redact.ts";

/**
 * The urgent channel: a push notification, on a phone, when something is wrong.
 *
 * Telegram because it is a bot token and a chat id — no app to publish, no
 * certificate to renew, and nothing to keep alive between messages. The whole
 * integration is one POST.
 */

const API = "https://api.telegram.org";

/** Telegram's own ceiling. Longer messages are rejected, not truncated for us. */
const MAX_MESSAGE = 4_096;

/** Beyond this many alerts in one run, something is wrong with the summariser. */
const MAX_ALERTS_PER_RUN = 3;

export type AlertSeverity = "urgent" | "info";

export interface Alert {
  severity: AlertSeverity;
  message: string;
  sentAt: Date;
}

export const notificationsEnabled = (config: AgentConfig): boolean =>
  Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);

/**
 * Sends one message. Returns false when the channel is not configured, throws
 * when it is configured and failed — the two are different findings, and a
 * silent channel that everyone believes is working is the failure this whole
 * feature exists to notice.
 */
export async function sendPush(config: AgentConfig, text: string): Promise<boolean> {
  if (!notificationsEnabled(config)) return false;

  const res = await fetch(`${API}/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.TELEGRAM_CHAT_ID,
      // No parse_mode: the text carries model output and log excerpts, and
      // Markdown would turn an unbalanced backtick in a stack trace into a
      // rejected message. Plain text cannot fail that way.
      text: text.slice(0, MAX_MESSAGE),
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    // The body carries Telegram's own description, which is the difference
    // between "wrong chat id" and "bot was blocked by the user".
    throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  return true;
}

/** Link back to the window under discussion, when an origin is configured. */
const linkTo = (config: AgentConfig, path: string): string =>
  config.AGENT_LINK_BASE ? `\n\n${new URL(path, config.AGENT_LINK_BASE).toString()}` : "";

/**
 * The tool that lets a summary raise its own alarm.
 *
 * Given to the model rather than driven from the flags alone because the flags
 * are arithmetic: they catch a cost spike and a repetition loop, but not "the
 * agent is reading credentials out of the environment", which has no numeric
 * signature and is the thing actually worth waking someone for.
 *
 * Alerts are collected as they are sent so the caller can record what went out.
 */
export function alertTool(config: AgentConfig, sent: Alert[], path = "/agent"): ToolSpec {
  return {
    name: "send_alert",
    description:
      "Send a push notification to the person responsible for this agent. Use it only for something that should interrupt them now: evidence of compromise, credential handling, destructive commands, exfiltration, or runaway spend. Routine anomalies belong in the written summary, not here.",
    parameters: {
      type: "object",
      properties: {
        severity: {
          type: "string",
          enum: ["urgent", "info"],
          description: "urgent interrupts; info is for something they should see today",
        },
        message: {
          type: "string",
          description: "one or two sentences, specific enough to act on",
          maxLength: 1_000,
        },
      },
      required: ["severity", "message"],
    },
    run: async (args) => {
      if (!notificationsEnabled(config)) {
        return "No notification channel is configured. Put this in the written summary instead.";
      }
      if (sent.length >= MAX_ALERTS_PER_RUN) {
        return "Alert limit for this run reached. Put anything further in the written summary.";
      }

      const severity: AlertSeverity = args.severity === "info" ? "info" : "urgent";
      const message = redact(String(args.message ?? "").trim()).text;
      if (!message) return "error: message is required";

      const prefix = severity === "urgent" ? "! agent alert" : "agent note";
      await sendPush(config, `${prefix}\n\n${message}${linkTo(config, path)}`);
      sent.push({ severity, message, sentAt: new Date() });

      return "Sent.";
    },
  };
}

/**
 * "Your catch-up is ready."
 *
 * Only the on-demand brief announces itself. The hourly run stays silent unless
 * it has something urgent to say — a notification every hour is one nobody
 * reads, and the whole point of the channel is that its arrival means
 * something. A catch-up is different: a person asked for it, it can take
 * minutes, and by the time it lands they have usually closed the tab.
 */
export interface CompletionDigest {
  start: Date;
  end: Date;
  callCount: number;
  costUsd: number;
  flags: { severity: string; detail: string }[];
  narrative: string;
  /** Where the full brief lives, e.g. `/agent/summaries/<id>`. */
  path: string;
  /** Alerts already pushed while writing it, so the message can say so. */
  alertsSent: number;
}

/** How much narrative rides along. The rest is one tap away. */
const DIGEST_CHARS = 700;

const stamp = (d: Date): string => d.toISOString().slice(0, 16).replace("T", " ");

/** Costs here are often fractions of a cent; two decimals would show "$0.00". */
const money = (usd: number): string =>
  usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

function excerpt(narrative: string): string {
  const flat = narrative.trim();
  if (flat.length <= DIGEST_CHARS) return flat;

  // Cut at a paragraph if one falls in range, otherwise at a word — a push that
  // ends mid-word reads as a truncation bug rather than a summary.
  const cut = flat.slice(0, DIGEST_CHARS);
  const para = cut.lastIndexOf("\n\n");
  const body = para > DIGEST_CHARS * 0.5 ? cut.slice(0, para) : cut.replace(/\s\S*$/, "");
  return `${body}…`;
}

export function completionMessage(config: AgentConfig, digest: CompletionDigest): string {
  const concerns = digest.flags.filter((f) => f.severity === "concern").length;
  const notices = digest.flags.length - concerns;

  const counts = [
    `${digest.callCount.toLocaleString("en-US")} calls`,
    money(digest.costUsd),
    concerns > 0 ? `${concerns} concern${concerns === 1 ? "" : "s"}` : null,
    notices > 0 ? `${notices} notice${notices === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return [
    concerns > 0 ? "! catch-up ready" : "catch-up ready",
    "",
    `${stamp(digest.start)} – ${stamp(digest.end)} UTC`,
    counts,
    // Said out loud so two pushes in a row do not read as a duplicate.
    digest.alertsSent > 0
      ? `\n(${digest.alertsSent} alert${digest.alertsSent === 1 ? "" : "s"} already sent separately)`
      : "",
    "",
    excerpt(digest.narrative),
  ]
    .filter((line) => line !== "")
    .join("\n")
    .concat(linkTo(config, digest.path));
}

/**
 * How often to prove the channel still works.
 *
 * A notification channel nobody has exercised is a channel nobody knows is
 * broken — a revoked token or a blocked bot is silent in exactly the same way
 * as "nothing was wrong". So the summariser pings itself, often at first and
 * then progressively less as the channel accumulates a record of working.
 *
 * Any successful send counts as proof, so a channel carrying real alerts stops
 * sending probes altogether.
 */
export const PROBE_MIN_MINUTES = 60;
export const PROBE_MAX_MINUTES = 7 * 24 * 60;

export interface ProbeState {
  /** When anything last arrived on the channel, probe or alert. */
  lastSendAt: Date | null;
  /** Current gap. Doubles on each probe, capped at a week. */
  intervalMinutes: number;
}

export function probeDue(state: ProbeState, now: Date): boolean {
  if (!state.lastSendAt) return true;
  const elapsed = (now.getTime() - state.lastSendAt.getTime()) / 60_000;
  return elapsed >= Math.max(PROBE_MIN_MINUTES, state.intervalMinutes);
}

/** The gap to use after a probe has just gone out. */
export const advanceInterval = (intervalMinutes: number): number =>
  Math.min(PROBE_MAX_MINUTES, Math.max(PROBE_MIN_MINUTES, intervalMinutes) * 2);

export function probeMessage(config: AgentConfig, now: Date, nextMinutes: number): string {
  const hours = Math.round(nextMinutes / 60);
  const next = hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  return (
    [
      "agent channel check",
      "",
      `The summariser is running and this channel works. ${now.toISOString().slice(0, 16)}Z.`,
      `Next check in about ${next} unless a real alert arrives first.`,
    ].join("\n") + linkTo(config, "/agent")
  );
}
