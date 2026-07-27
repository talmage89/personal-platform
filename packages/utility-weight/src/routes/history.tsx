import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import { sessionOf, WeightPage } from "../components.tsx";
import {
  addDays,
  type DateKey,
  dateRange,
  daysBetween,
  formatDay,
  isDateKey,
  relativeDay,
} from "../dates.ts";
import { deleteEntry, entriesBetween, loadContext, saveEntry } from "../repository.ts";
import { formatWeight, parseWeightInput, unitLabel } from "../units.ts";

const WINDOW = 30;

/**
 * Backfilling past days.
 *
 * One form over the whole window rather than one form per row: the actual task
 * is "I missed Tuesday, Wednesday and Friday", and thirty separate submits
 * would make that three page loads instead of one. Every day in the window is a
 * field, blank ones included, so a gap is something you type into rather than
 * something you first have to open a dialog for.
 *
 * Clearing a field that had a value deletes that entry — the same gesture the
 * eye expects, and the only way to remove a bad reading without a separate
 * control on every row.
 *
 * Only changed fields are written. Submitting thirty unchanged rows costs zero
 * queries, which matters when every one of them is a round trip to Neon.
 */
export function createHistoryRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    const { user, settings, today } = await loadContext(sessionOf(c).sub);

    const end = resolveEnd(c.req.query("end"), today);
    const start = addDays(end, -(WINDOW - 1));

    const entries = await entriesBetween(user.id, start, end);
    const byDay = new Map(entries.map((entry) => [entry.day, entry.grams]));

    // Newest first: the days most likely to need filling are the recent ones.
    const days = dateRange(start, end).reverse();

    const saved = Number(c.req.query("saved") ?? 0);
    const removed = Number(c.req.query("removed") ?? 0);
    const rejected = Number(c.req.query("rejected") ?? 0);

    return c.html(
      <WeightPage current="history">
        <form method="get" action="/weight/history" class="mb-8 flex items-baseline gap-3 text-sm">
          <label for="end" class="text-muted">
            ending
          </label>
          <input
            id="end"
            name="end"
            type="date"
            value={end}
            max={today}
            class="border-b bg-transparent pb-0.5"
          />
          <button type="submit" class="ml-1 cursor-pointer underline hover:no-underline">
            go
          </button>
        </form>

        {saved || removed || rejected ? (
          <p class="mb-6 text-muted text-sm">
            {[
              saved ? `${saved} saved` : null,
              removed ? `${removed} removed` : null,
              rejected ? `${rejected} ignored as invalid` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}

        <form method="post" action={`/weight/history?end=${end}`}>
          {/* Capped so the day and the field it belongs to stay near each other.
              Across the full 640px column they read as two unrelated lists. */}
          <table class="w-full max-w-sm">
            <tbody>
              {days.map((day) => {
                const grams = byDay.get(day);
                return (
                  <tr key={day}>
                    <td class="w-full py-1.5 pr-8 text-sm">
                      <span class={grams === undefined ? "text-muted" : ""}>
                        {relativeDay(day, today)}
                      </span>
                    </td>
                    <td class="py-1.5">
                      <input
                        name={`day:${day}`}
                        type="text"
                        inputmode="decimal"
                        autocomplete="off"
                        aria-label={formatDay(day)}
                        value={grams === undefined ? "" : formatWeight(grams, settings.unit)}
                        class="w-24 border-b bg-transparent pb-0.5 text-right tabular-nums"
                      />
                    </td>
                    <td class="py-1.5 pl-3 text-muted text-sm">{unitLabel(settings.unit)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div class="mt-8">
            <button type="submit" class="cursor-pointer underline hover:no-underline">
              save changes
            </button>
            <p class="mt-2 text-muted text-sm">clear a field to remove that day's entry</p>
          </div>
        </form>

        <nav class="mt-10 flex justify-between text-sm">
          <a href={`/weight/history?end=${addDays(start, -1)}`}>← earlier</a>
          {daysBetween(end, today) > 0 ? (
            <a href={`/weight/history?end=${laterEnd(end, today)}`}>later →</a>
          ) : (
            <span />
          )}
        </nav>
      </WeightPage>,
    );
  });

  routes.post("/", async (c) => {
    const { user, settings, today } = await loadContext(sessionOf(c).sub);

    const end = resolveEnd(c.req.query("end"), today);
    const start = addDays(end, -(WINDOW - 1));

    const existing = await entriesBetween(user.id, start, end);
    const byDay = new Map(existing.map((entry) => [entry.day, entry.grams]));

    const form = await c.req.formData();

    const writes: Promise<void>[] = [];
    let saved = 0;
    let removed = 0;
    let rejected = 0;

    for (const day of dateRange(start, end)) {
      const raw = form.get(`day:${day}`);
      if (typeof raw !== "string") continue;

      const trimmed = raw.trim();
      const current = byDay.get(day);

      if (trimmed === "") {
        if (current !== undefined) {
          writes.push(deleteEntry(user.id, day));
          removed++;
        }
        continue;
      }

      const grams = parseWeightInput(trimmed, settings.unit);
      if (grams === null) {
        rejected++;
        continue;
      }

      // The check that makes an unchanged submit free.
      if (grams !== current) {
        writes.push(saveEntry(user.id, day, grams));
        saved++;
      }
    }

    // Independent rows, so these can go together rather than one round trip
    // after another. At most thirty, which is well inside anything Neon minds.
    await Promise.all(writes);

    const params = new URLSearchParams({ end });
    if (saved) params.set("saved", String(saved));
    if (removed) params.set("removed", String(removed));
    if (rejected) params.set("rejected", String(rejected));

    return c.redirect(`/weight/history?${params}`, 303);
  });

  return routes;
}

/** Clamped to today: there is nothing to log in the future. */
function resolveEnd(raw: string | undefined, today: DateKey): DateKey {
  if (!isDateKey(raw)) return today;
  return daysBetween(raw, today) < 0 ? today : raw;
}

function laterEnd(end: DateKey, today: DateKey): DateKey {
  const next = addDays(end, WINDOW);
  return daysBetween(next, today) < 0 ? today : next;
}
