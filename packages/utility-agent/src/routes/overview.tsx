import { agentConfig, NotConfiguredError, summarizeWindow } from "@platform/agent-core";
import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import { AgentPage, NotConfigured, Stat, SummaryCard, sessionOf } from "../components.tsx";
import { formatCost, formatCount, formatDuration } from "../format.ts";
import {
  baselineHistory,
  knownModels,
  lastScheduledEnd,
  lastViewedAt,
  markViewed,
  recentSummaries,
  saveSummary,
} from "../repository.ts";

/**
 * The one page. It answers "what has the agent been doing", and offers to
 * close the gap between the last scheduled summary and now.
 *
 * No client JavaScript: the platform serves `script-src 'none'`, so catching up
 * is a native form POST followed by a redirect. That also makes the slow path
 * honest — the browser shows it is loading for as long as the work takes,
 * rather than a spinner that lies about what is happening.
 */

/**
 * Ceiling on a single on-demand window.
 *
 * Without it, a fortnight away turns one button press into a query over the
 * whole absence and a prompt far too large to be useful. Capped, the button
 * summarises the most recent day and the scheduled runs keep filling in behind.
 */
const MAX_CATCH_UP_HOURS = 24;

export function createOverviewRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    if (!agentConfig()) return c.html(<NotConfigured />);

    const session = sessionOf(c);
    const now = new Date();
    const [summaries, viewed] = await Promise.all([recentSummaries(), lastViewedAt(session.sub)]);

    const newest = summaries[0];
    const unread = viewed ? summaries.filter((s) => s.createdAt > viewed).length : summaries.length;

    // A day's worth of scheduled windows, for the headline numbers. Manual
    // windows are excluded: they overlap the scheduled ones, and counting both
    // would double whatever a person had already pressed the button for.
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const recent = summaries.filter((s) => s.kind === "scheduled" && s.periodEnd > dayAgo);
    const dayCost = recent.reduce((sum, s) => sum + s.costUsd, 0);
    const dayCalls = recent.reduce((sum, s) => sum + s.callCount, 0);
    const concerns = recent.filter((s) => s.flags.some((f) => f.severity === "concern")).length;

    const gapFrom = viewed ?? newest?.periodEnd ?? null;
    const gapHours = gapFrom ? (now.getTime() - gapFrom.getTime()) / 3_600_000 : null;

    const failed = c.req.query("failed");
    const caught = c.req.query("caught") !== undefined;

    return c.html(
      <AgentPage>
        <div class="grid grid-cols-3 gap-x-6">
          <Stat
            label="calls · 24h"
            value={formatCount(dayCalls)}
            detail={`${recent.length} windows`}
          />
          <Stat label="spend · 24h" value={formatCost(dayCost)} />
          <Stat
            label="concerns"
            value={String(concerns)}
            detail={concerns === 0 ? "nothing flagged" : "in the last day"}
          />
        </div>

        <form method="post" action="/agent/catch-up" class="mt-8">
          <button type="submit" class="cursor-pointer underline hover:no-underline">
            summarise since last time
          </button>
          <span class="ml-3 text-muted text-sm">
            {gapHours === null
              ? "nothing summarised yet"
              : gapHours < 0.05
                ? "up to date"
                : `${formatDuration(gapFrom as Date, now)} unsummarised`}
            {unread > 0 ? ` · ${unread} new since you last looked` : ""}
          </span>
        </form>

        {failed ? (
          <p class="mt-4 text-sm">Could not summarise: {failed}</p>
        ) : caught ? (
          <p class="mt-4 text-muted text-sm">caught up</p>
        ) : null}

        {summaries.length === 0 ? (
          <>
            <hr class="my-8" />
            <p class="text-muted text-sm">
              No summaries yet. The hourly job writes the first one at the top of the next hour, or
              press the button above.
            </p>
          </>
        ) : (
          summaries.map((summary) => <SummaryCard key={summary.id} summary={summary} now={now} />)
        )}
      </AgentPage>,
    );
  });

  routes.post("/catch-up", async (c) => {
    const session = sessionOf(c);
    const now = new Date();

    // Where to resume from, most specific first: where this person had read up
    // to, else the end of the scheduled record, else the last hour.
    const [viewed, scheduledEnd] = await Promise.all([
      lastViewedAt(session.sub),
      lastScheduledEnd(),
    ]);

    const floor = new Date(now.getTime() - MAX_CATCH_UP_HOURS * 3_600_000);
    const candidate = viewed ?? scheduledEnd ?? new Date(now.getTime() - 3_600_000);
    const start = candidate < floor ? floor : candidate;

    // A window of a few seconds would spend a model call to say "nothing
    // happened". Mark the visit and return.
    if (now.getTime() - start.getTime() < 60_000) {
      await markViewed(session.sub, now);
      return c.redirect("/agent?caught", 303);
    }

    try {
      const [history, models] = await Promise.all([baselineHistory(), knownModels()]);
      const summary = await summarizeWindow({
        window: { start, end: now },
        history,
        knownModels: models,
      });

      await saveSummary(summary, "manual");
      await markViewed(session.sub, now);
      return c.redirect("/agent?caught", 303);
    } catch (error) {
      if (error instanceof NotConfiguredError) return c.redirect("/agent", 303);

      console.error("catch-up failed", error);
      const message = error instanceof Error ? error.message : "unknown error";
      return c.redirect(`/agent?failed=${encodeURIComponent(message.slice(0, 200))}`, 303);
    }
  });

  return routes;
}
