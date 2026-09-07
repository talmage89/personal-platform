import type { AuthEnv, SessionPayload } from "@platform/auth";
import { Layout } from "@platform/ui";
import type { Context } from "hono";
import type { PropsWithChildren } from "hono/jsx";
import {
  formatCost,
  formatCount,
  formatTokens,
  formatWindow,
  relativeAge,
  worstSeverity,
} from "./format.ts";
import type { StoredSummary } from "./repository.ts";

/**
 * The session is guaranteed by the gate, so this reads it rather than checking
 * for it. Same helper as the weight utility, for the same reason.
 */
export function sessionOf(c: Context<AuthEnv>): SessionPayload {
  const session = c.get("session");
  if (!session) throw new Error("reached a gated route without a session");
  return session;
}

export function AgentPage({ children }: PropsWithChildren) {
  return <Layout title="agent">{children}</Layout>;
}

export function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <div class="text-muted text-sm">{label}</div>
      <div class="mt-1 text-2xl tabular-nums leading-tight">{value}</div>
      {detail ? <div class="mt-1 text-muted text-sm">{detail}</div> : null}
    </div>
  );
}

/**
 * A flag, rendered as a sentence rather than a badge.
 *
 * The severity is carried by a leading mark instead of colour: the palette
 * flips with the system theme and there is no client JavaScript to re-tint
 * anything, so a red pill would have to be two colours defined in two places.
 * `!` and `·` read identically in both themes and in a screen reader.
 */
export function FlagLine({ severity, detail }: { severity: string; detail: string }) {
  const concern = severity === "concern";
  return (
    <li class={`mt-1 text-sm ${concern ? "" : "text-muted"}`}>
      <span class="tabular-nums">{concern ? "!" : "·"}</span> {detail}
    </li>
  );
}

/**
 * One window. The narrative is the point of the page, so it is set in body
 * text; everything else is supporting detail and sits at `text-sm`.
 */
export function SummaryCard({ summary, now }: { summary: StoredSummary; now: Date }) {
  const severity = worstSeverity(summary.flags);

  return (
    <article class="mt-8">
      <hr class="mb-8" />

      <header class="flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 class="tabular-nums">
          {severity === "concern" ? "! " : ""}
          {formatWindow(summary.periodStart, summary.periodEnd)}
        </h2>
        <span class="text-muted text-sm">
          {summary.kind === "manual" ? "on demand · " : ""}
          {relativeAge(summary.createdAt, now)}
        </span>
      </header>

      <p class="mt-2 text-muted text-sm tabular-nums">
        {formatCount(summary.callCount)} calls · {formatCost(summary.costUsd)} ·{" "}
        {formatTokens(summary.totalTokens)} tokens
        {summary.errorCount > 0 ? ` · ${formatCount(summary.errorCount)} errors` : ""}
      </p>

      {summary.flags.length > 0 ? (
        <ul class="mt-3">
          {summary.flags.map((flag) => (
            <FlagLine key={flag.code} severity={flag.severity} detail={flag.detail} />
          ))}
        </ul>
      ) : null}

      {/* Paragraph breaks survive the trip through the database as blank lines. */}
      {summary.narrative.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index} class="mt-3">
          {paragraph}
        </p>
      ))}

      {summary.models.length > 0 ? (
        <p class="mt-3 text-muted text-sm tabular-nums">
          {summary.models.map((m) => `${m.model} ×${m.calls}`).join(" · ")}
        </p>
      ) : null}
    </article>
  );
}

/** Shown when the deployment has no access to the logs configured. */
export function NotConfigured() {
  return (
    <AgentPage>
      <p>This deployment has no log source configured.</p>
      <p class="mt-3 text-muted text-sm">
        The summariser needs read access to the trace table and a model key. Both arrive from the
        environment; see the deployment notes.
      </p>
    </AgentPage>
  );
}

/**
 * One line per window, for scanning a lot of them.
 *
 * The overview shows summaries in full because it shows a handful; this is the
 * other question — "when did that start" — and answering it means fitting a day
 * on a screen. Everything here is fixed-width or truncated so the columns line
 * up down the page and a concern is visible without reading any of it.
 */
export function SummaryRow({ summary }: { summary: StoredSummary }) {
  const severity = worstSeverity(summary.flags);

  return (
    <li class="border-current/10 border-b">
      <a href={`/agent/summaries/${summary.id}`} class="block py-3 no-underline hover:bg-current/5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4">
          <span class="tabular-nums">
            {severity === "concern" ? "! " : severity === "notice" ? "· " : "  "}
            {formatWindow(summary.periodStart, summary.periodEnd)}
          </span>
          <span class="text-muted text-sm tabular-nums">
            {formatCount(summary.callCount)} calls · {formatCost(summary.costUsd)}
            {summary.kind === "manual" ? " · on demand" : ""}
          </span>
        </div>
        <p class="mt-1 line-clamp-2 text-muted text-sm">{firstSentences(summary.narrative)}</p>
      </a>
    </li>
  );
}

/** Enough of the narrative to recognise the hour, without the whole thing. */
function firstSentences(narrative: string, max = 180): string {
  const flat = narrative.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).replace(/\s\S*$/, "")}…`;
}

/**
 * What the summariser went and read.
 *
 * Shown because a narrative that checked and a narrative that guessed read
 * exactly alike, and the difference is the reason to believe this page.
 */
export function Investigation({ calls }: { calls: { name: string; args: string; ok: boolean }[] }) {
  if (calls.length === 0) return null;

  return (
    <details class="mt-3">
      <summary class="cursor-pointer text-muted text-sm">
        looked at {calls.length} thing{calls.length === 1 ? "" : "s"}
      </summary>
      <ul class="mt-2">
        {calls.map((call, index) => (
          <li key={index} class="text-muted text-sm">
            <code>{call.name}</code> {call.args}
            {call.ok ? "" : " — failed"}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Notifications this summary pushed. Rare by design, so never collapsed. */
export function Alerts({ alerts }: { alerts: { severity: string; message: string }[] }) {
  if (alerts.length === 0) return null;

  return (
    <ul class="mt-3">
      {alerts.map((alert, index) => (
        <li key={index} class="mt-1 text-sm">
          <span class="tabular-nums">{alert.severity === "urgent" ? "!" : "·"}</span> notified:{" "}
          {alert.message}
        </li>
      ))}
    </ul>
  );
}

/** Prev/next only. Numbered pages would need a count nobody reads. */
export function Pager({ page, pages }: { page: number; pages: number }) {
  if (pages <= 1) return null;

  return (
    <nav class="mt-8 flex justify-between text-sm">
      {page > 0 ? (
        <a href={`/agent/summaries?page=${page - 1}`}>← newer</a>
      ) : (
        <span class="text-muted">← newer</span>
      )}
      <span class="text-muted tabular-nums">
        {page + 1} / {pages}
      </span>
      {page + 1 < pages ? (
        <a href={`/agent/summaries?page=${page + 1}`}>older →</a>
      ) : (
        <span class="text-muted">older →</span>
      )}
    </nav>
  );
}
