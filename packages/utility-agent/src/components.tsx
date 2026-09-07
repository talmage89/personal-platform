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
