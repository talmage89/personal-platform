import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import { paceAgainst, weekOverWeek } from "../analytics.ts";
import { ConfidenceNote, Stat, sessionOf, WeightPage } from "../components.tsx";
import { addDays, formatDay } from "../dates.ts";
import { entriesBetween, loadContext, saveEntry } from "../repository.ts";
import { formatDelta, formatWeight, parseWeightInput, rateLabel, unitLabel } from "../units.ts";

/**
 * The daily flow, and the page worth bookmarking: open it, type a number, close
 * it. Everything else on the page is glanceable — nothing below the input needs
 * to be read for the entry to be recorded.
 *
 * The form is a native POST with a redirect back, so the whole loop works with
 * no client JavaScript. `autofocus` puts the cursor in the field on load and
 * Enter submits, which makes the common case keyboard-only.
 */
export function createDailyRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    const { user, settings, today } = await loadContext(sessionOf(c).sub);

    // Fourteen days is exactly what the headline needs: this week and the one
    // before it. No reason to read more on the page that gets opened daily.
    const entries = await entriesBetween(user.id, addDays(today, -13), today);
    const todays = entries.find((entry) => entry.day === today) ?? null;

    const comparison = weekOverWeek(entries, today);
    const pace =
      comparison.deltaG !== null ? paceAgainst(comparison.deltaG, settings.targetRateG) : null;

    const saved = c.req.query("saved") !== undefined;
    const invalid = c.req.query("invalid") !== undefined;

    return c.html(
      <WeightPage current="today">
        <form method="post" action="/weight">
          <label for="weight" class="text-muted text-sm">
            {formatDay(today)}
          </label>

          <div class="mt-2 flex items-baseline gap-3">
            <input
              id="weight"
              name="weight"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              // autofocus is usually a nuisance; here it is the feature. The page
              // exists to receive one number, and this makes the daily loop
              // open-type-enter without touching the mouse.
              autofocus
              value={todays ? formatWeight(todays.grams, settings.unit) : ""}
              placeholder="—"
              class="w-40 border-b bg-transparent pb-1 text-4xl tabular-nums outline-none"
            />
            <span class="text-muted text-xl">{unitLabel(settings.unit)}</span>
            <button type="submit" class="ml-4 cursor-pointer underline hover:no-underline">
              {todays ? "update" : "save"}
            </button>
          </div>
        </form>

        {invalid ? (
          <p class="mt-4 text-sm">
            That did not look like a weight in {unitLabel(settings.unit)}. Nothing was saved.
          </p>
        ) : null}
        {saved && !invalid ? <p class="mt-4 text-muted text-sm">saved</p> : null}
        {todays && !saved && !invalid ? (
          <p class="mt-4 text-muted text-sm">Already logged today. Changing it replaces it.</p>
        ) : null}

        <hr class="my-8" />

        <div class="grid grid-cols-2 gap-x-8 gap-y-8">
          <Stat
            label="7-day average"
            large
            value={
              comparison.current.mean === null
                ? "—"
                : formatWeight(comparison.current.mean, settings.unit)
            }
            unit={comparison.current.mean === null ? undefined : unitLabel(settings.unit)}
            detail={`${comparison.current.n}/7 days logged`}
          />
          <Stat
            label="vs previous 7 days"
            large
            value={comparison.deltaG === null ? "—" : formatDelta(comparison.deltaG, settings.unit)}
            unit={comparison.deltaG === null ? undefined : rateLabel(settings.unit)}
            detail={`${comparison.previous.n}/7 days logged`}
          />
          <Stat
            label="target"
            value={formatDelta(settings.targetRateG, settings.unit)}
            unit={rateLabel(settings.unit)}
            detail={pace ? paceLabel(pace.status) : undefined}
          />
        </div>

        <ConfidenceNote
          confidence={comparison.confidence}
          currentN={comparison.current.n}
          previousN={comparison.previous.n}
        />

        <p class="mt-10 text-sm">
          <a href="/weight/metrics">everything else →</a>
        </p>
      </WeightPage>,
    );
  });

  routes.post("/", async (c) => {
    const { user, settings, today } = await loadContext(sessionOf(c).sub);

    const form = await c.req.formData();
    const grams = parseWeightInput(form.get("weight"), settings.unit);

    // Redirect either way — a rejected entry must not leave the page in a state
    // that a refresh would resubmit.
    if (grams === null) return c.redirect("/weight?invalid", 303);

    await saveEntry(user.id, today, grams);
    return c.redirect("/weight?saved", 303);
  });

  return routes;
}

function paceLabel(status: "over" | "on-track" | "under"): string {
  if (status === "on-track") return "on track";
  return status === "over" ? "gaining faster than target" : "gaining slower than target";
}
