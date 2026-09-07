import { agentConfig } from "@platform/agent-core";
import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import {
  AgentPage,
  Alerts,
  Investigation,
  NotConfigured,
  Pager,
  SummaryCard,
  SummaryRow,
} from "../components.tsx";
import { summariesPage, summaryById } from "../repository.ts";

/**
 * The history, as a list.
 *
 * The overview answers "what is happening"; this answers "when did that start",
 * which needs many windows on one screen rather than a few in full. Paged rather
 * than infinite: there is no client JavaScript to scroll with, and a link the
 * browser can follow is also a link that can be bookmarked and shared.
 */

const PAGE_SIZE = 25;

export function createSummaryRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    if (!agentConfig()) return c.html(<NotConfigured />);

    // A hand-edited page number is a typo, not an attack — clamp it rather than
    // erroring, so a stale bookmark lands on something sensible.
    const requested = Number.parseInt(c.req.query("page") ?? "0", 10);
    const page = Number.isFinite(requested) && requested > 0 ? requested : 0;

    const { rows, total } = await summariesPage(page * PAGE_SIZE, PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return c.html(
      <AgentPage>
        <p class="text-muted text-sm">
          <a href="/agent">← overview</a>
        </p>

        {rows.length === 0 ? (
          <p class="mt-8">Nothing summarised yet.</p>
        ) : (
          <>
            <p class="mt-6 text-muted text-sm tabular-nums">{total} windows</p>
            <ul class="mt-2">
              {rows.map((summary) => (
                <SummaryRow key={summary.id} summary={summary} />
              ))}
            </ul>
            <Pager page={page} pages={pages} />
          </>
        )}
      </AgentPage>,
    );
  });

  routes.get("/:id", async (c) => {
    if (!agentConfig()) return c.html(<NotConfigured />);

    const summary = await summaryById(c.req.param("id"));
    if (!summary) return c.notFound();

    return c.html(
      <AgentPage>
        <p class="text-muted text-sm">
          <a href="/agent/summaries">← all summaries</a>
        </p>
        <SummaryCard summary={summary} now={new Date()} />
        <Alerts alerts={summary.alerts} />
        <Investigation calls={summary.investigation} />
        {summary.narrationCostUsd > 0 ? (
          <p class="mt-6 text-muted text-sm tabular-nums">
            writing this summary cost ${summary.narrationCostUsd.toFixed(4)}
          </p>
        ) : null}
      </AgentPage>,
    );
  });

  return routes;
}
