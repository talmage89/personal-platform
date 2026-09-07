import {
  agentConfig,
  dispatchJob,
  jobDispatchEnabled,
  NotConfiguredError,
  notificationsEnabled,
} from "@platform/agent-core";
import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import { AgentPage, NotConfigured, Stat, SummaryCard, sessionOf } from "../components.tsx";
import { formatCost, formatCount, formatDuration, relativeAge } from "../format.ts";
import { catchUp } from "../jobs.ts";
import {
  channelState,
  lastScheduledEnd,
  lastViewedAt,
  markViewed,
  recentSummaries,
} from "../repository.ts";

/**
 * The one page. It answers "what has the agent been doing", and offers to
 * close the gap between the last scheduled summary and now.
 *
 * No client JavaScript: the platform serves `script-src 'none'`, so catching up
 * is a native form POST followed by a redirect.
 *
 * The redirect is immediate and the work is not done here. It was, once, and
 * the button never worked: a catch-up runs for minutes, the connection is
 * closed after ten idle seconds, and every press ended in a failure page while
 * the summary went on being written and billed with nowhere to go. Handing the
 * work to a job and telling you it started is both the honest answer and the
 * only one that survives the wait.
 */

/**
 * Ceiling on a single on-demand window.
 *
 * Without it, a fortnight away turns one button press into a query over the
 * whole absence and a prompt far too large to be useful. Capped, the button
 * summarises the most recent day and the scheduled runs keep filling in behind.
 */
const MAX_CATCH_UP_HOURS = 24;

/**
 * How many windows to render in full here. The rest live on the list page —
 * this is the "what is happening" view, not the archive.
 */
const RECENT_ON_OVERVIEW = 8;

/**
 * How long a dispatched catch-up is still worth describing as "in progress".
 *
 * Matches the job's own budget. Past it the job has either finished or died,
 * and continuing to claim it is running would be the page inventing a state it
 * has no evidence for — the failure this notice was added to avoid.
 */
const CATCH_UP_PATIENCE_MS = 45 * 60_000;

export function createOverviewRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    const config = agentConfig();
    if (!config) return c.html(<NotConfigured />);

    const session = sessionOf(c);
    const now = new Date();
    const [summaries, viewed, channel] = await Promise.all([
      recentSummaries(RECENT_ON_OVERVIEW),
      lastViewedAt(session.sub),
      channelState(),
    ]);

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

    // When the catch-up was dispatched, not merely that it was. The parameter
    // alone is a claim that never expires: it survives every reload, so the
    // page went on saying "catching up" long after the summary had landed and
    // was sitting directly below the notice. Carrying the instant lets the
    // page check whether anything has been stored since, and say so.
    const startedAt = Number(c.req.query("started"));
    const started = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null;
    const landed = started !== null && summaries.some((s) => s.createdAt.getTime() > started);
    const givenUp = started !== null && now.getTime() - started > CATCH_UP_PATIENCE_MS;

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
        ) : landed || caught ? (
          <p class="mt-4 text-muted text-sm">caught up</p>
        ) : started !== null && givenUp ? (
          <p class="mt-4 text-sm">
            ! that catch-up never stored a summary. It has had longer than the job is allowed to
            run, so it failed rather than is running.
          </p>
        ) : started !== null ? (
          <p class="mt-4 text-muted text-sm">
            catching up in the background — this takes a few minutes. Reload to see it, or wait for
            the notification.
          </p>
        ) : null}

        {channel.lastError ? (
          <p class="mt-4 text-sm">
            ! the notification channel last failed with: {channel.lastError}
          </p>
        ) : notificationsEnabled(config) && channel.lastSendAt ? (
          <p class="mt-4 text-muted text-sm">
            notifications working · last reached {relativeAge(channel.lastSendAt, now)}
          </p>
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

        <nav class="mt-10 border-current/10 border-t pt-4 text-sm">
          <a href="/agent/summaries">all summaries</a>
          <span class="text-muted"> · </span>
          <a href="/agent/prompts">edit prompts</a>
        </nav>
      </AgentPage>,
    );
  });

  routes.post("/catch-up", async (c) => {
    const config = agentConfig();
    if (!config) return c.redirect("/agent", 303);

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
      // Where a deployment has somewhere to put the work, put it there and
      // return. A catch-up takes minutes; a connection that has sent nothing
      // for ten seconds is closed under us, so waiting here does not fail
      // gracefully — it fails at twelve seconds, every time, while the summary
      // carries on being written and paid for with nowhere to be delivered.
      //
      // Dispatch first, mark second. The mark is what "since last time" is
      // measured from, so advancing it for a job that never started would
      // quietly discard the very window you asked about — and you would not
      // find out until the next catch-up came back describing less than it
      // should. Marking twice costs nothing; marking too early costs a window.
      if (jobDispatchEnabled(config)) {
        await dispatchJob(config, ["dist/job.js", "agent", "catch-up", start.toISOString()]);
        await markViewed(session.sub, now);
        return c.redirect(`/agent?started=${now.getTime()}`, 303);
      }

      // No job configured — a laptop, or a test. Run it here, where nothing is
      // proxying the connection and the wait is honest.
      await catchUp(start, now);
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
