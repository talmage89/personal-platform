import type { AuthEnv, SessionPayload } from "@platform/auth";
import { Layout } from "@platform/ui";
import type { Context } from "hono";
import type { PropsWithChildren } from "hono/jsx";
import type { Confidence } from "./analytics.ts";

export type Page = "today" | "history" | "metrics" | "settings";

const PAGES: { page: Page; href: string; label: string }[] = [
  { page: "today", href: "/weight", label: "today" },
  { page: "history", href: "/weight/history", label: "history" },
  { page: "metrics", href: "/weight/metrics", label: "metrics" },
  { page: "settings", href: "/weight/settings", label: "settings" },
];

/**
 * The chrome shared by every weight page: the platform layout, plus a row of
 * links to the other three. The current page is rendered as plain text rather
 * than a link to itself.
 */
export function WeightPage({ current, children }: PropsWithChildren<{ current: Page }>) {
  return (
    <Layout title="weight">
      <nav class="mb-8 text-sm">
        {PAGES.map(({ page, href, label }, index) => (
          <span key={page}>
            {index > 0 ? <span class="text-muted"> · </span> : null}
            {page === current ? (
              <span class="text-muted">{label}</span>
            ) : (
              <a href={href}>{label}</a>
            )}
          </span>
        ))}
      </nav>
      {children}
    </Layout>
  );
}

/**
 * A ruled block with a heading. Every section below the fold on metrics opens
 * with one, so the rhythm between rule, heading and content is decided here
 * rather than re-typed — which is how it drifted in the first place.
 */
export function Section({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <section>
      <hr class="my-8" />
      <h2 class="mb-3">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A labelled number. The dashboard is mostly made of these.
 *
 * The unit is a separate prop rather than part of `value` so the two can be
 * sized and coloured apart — the number is the thing being read, "lb/wk" is
 * only there to say what it counts.
 */
export function Stat({
  label,
  value,
  unit,
  detail,
  large = false,
}: {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  large?: boolean;
}) {
  return (
    <div>
      <div class="text-muted text-sm">{label}</div>
      <div class={`mt-1 flex items-baseline gap-2 ${large ? "text-3xl leading-tight" : ""}`}>
        <span class="tabular-nums">{value}</span>
        {unit ? <span class={`text-muted ${large ? "text-lg" : "text-sm"}`}>{unit}</span> : null}
      </div>
      {detail ? <div class="mt-1.5 text-muted text-sm">{detail}</div> : null}
    </div>
  );
}

/**
 * The honesty note beside the headline rate.
 *
 * A week-over-week delta built from two readings against seven looks exactly
 * like one built from fourteen. Saying so is the difference between a number
 * that informs and a number that misleads.
 */
export function ConfidenceNote({
  confidence,
  currentN,
  previousN,
}: {
  confidence: Confidence;
  currentN: number;
  previousN: number;
}) {
  if (confidence === "good") return null;

  return (
    <p class="mt-4 text-muted text-sm">
      {confidence === "none"
        ? "Not enough history yet to compare two weeks."
        : `Based on ${currentN} and ${previousN} readings — thin enough that day-to-day water
           movement can outweigh the trend.`}
    </p>
  );
}

/**
 * The session is guaranteed by `requireSession` upstream, but the type is not.
 * Throwing names the invariant instead of letting a `!` hide it — if these
 * routes are ever mounted outside the gate, this says so immediately.
 */
export function sessionOf(c: Context<AuthEnv>): SessionPayload {
  const session = c.get("session");
  if (!session) {
    throw new Error("weight routes must be mounted behind requireSession()");
  }
  return session;
}
