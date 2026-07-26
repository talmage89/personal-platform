import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import { sessionOf, WeightPage } from "../components.tsx";
import { availableTimeZones, isValidTimeZone, todayIn } from "../dates.ts";
import { loadContext, saveSettings, saveTimezone } from "../repository.ts";
import { formatRateInput, parseRateInput, parseUnit, rateLabel, UNITS } from "../units.ts";

/**
 * Per-person preferences.
 *
 * Timezone is stored on the user rather than here, because it is a fact about a
 * person and not about weight — the next utility that needs to know what "today"
 * means should read the same value rather than ask again. The form presents them
 * together anyway; only the storage differs.
 */
export function createSettingsRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    const { user, settings, today } = await loadContext(sessionOf(c).sub);
    const zones = availableTimeZones();

    const saved = c.req.query("saved") !== undefined;
    const invalid = c.req.query("invalid");

    return c.html(
      <WeightPage current="settings">
        <form method="post" action="/weight/settings">
          {/*
            The unit the form was rendered in. The target rate below is written
            in it, so the parse has to use it — otherwise switching lb to kg in
            the same submit would reinterpret an untouched rate as the new unit
            and silently more-than-double the goal.
          */}
          <input type="hidden" name="renderedUnit" value={settings.unit} />

          <div class="mb-6">
            <label for="unit" class="text-muted text-sm">
              units
            </label>
            <div>
              <select id="unit" name="unit" class="border-b bg-transparent py-1">
                {UNITS.map((unit) => (
                  <option key={unit} value={unit} selected={unit === settings.unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div class="mb-6">
            <label for="targetRate" class="text-muted text-sm">
              target rate
            </label>
            <div class="flex items-baseline gap-2">
              <input
                id="targetRate"
                name="targetRate"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                value={formatRateInput(settings.targetRateG, settings.unit)}
                class="w-24 border-b bg-transparent py-1"
              />
              <span class="text-muted text-sm">{rateLabel(settings.unit)}</span>
            </div>
            <p class="mt-1 text-muted text-sm">
              Positive to gain, negative to lose, zero to maintain.
            </p>
          </div>

          <div class="mb-6">
            <label for="timezone" class="text-muted text-sm">
              timezone
            </label>
            <div>
              <select id="timezone" name="timezone" class="max-w-full border-b bg-transparent py-1">
                {zones.map((zone) => (
                  <option key={zone} value={zone} selected={zone === user.timezone}>
                    {zone}
                  </option>
                ))}
              </select>
            </div>
            <p class="mt-1 text-muted text-sm">
              Decides which day a weigh-in belongs to. Right now that is {today}.
            </p>
          </div>

          <button type="submit" class="cursor-pointer underline hover:no-underline">
            save
          </button>
          {saved ? <span class="ml-3 text-muted text-sm">saved</span> : null}
          {invalid ? <span class="ml-3 text-sm">{invalidMessage(invalid)}</span> : null}
        </form>
      </WeightPage>,
    );
  });

  routes.post("/", async (c) => {
    const { user, settings } = await loadContext(sessionOf(c).sub);

    const form = await c.req.formData();

    const unit = parseUnit(form.get("unit")) ?? settings.unit;
    const renderedUnit = parseUnit(form.get("renderedUnit")) ?? settings.unit;
    const targetRateG = parseRateInput(form.get("targetRate"), renderedUnit);
    const timezone = form.get("timezone");

    if (targetRateG === null) return c.redirect("/weight/settings?invalid=rate", 303);
    if (!isValidTimeZone(timezone)) return c.redirect("/weight/settings?invalid=timezone", 303);

    // Proves the zone works before it is stored. An unrecognised one would make
    // every page that asks what day it is throw.
    todayIn(timezone);

    await Promise.all([
      saveSettings(user.id, { unit, targetRateG }),
      timezone === user.timezone ? Promise.resolve() : saveTimezone(user.id, timezone),
    ]);

    return c.redirect("/weight/settings?saved", 303);
  });

  return routes;
}

function invalidMessage(kind: string): string {
  if (kind === "rate") return "That target rate did not look like a number. Nothing was saved.";
  if (kind === "timezone") return "That timezone was not recognised. Nothing was saved.";
  return "Nothing was saved.";
}
