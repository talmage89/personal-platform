import { agentConfig, BUDGETS } from "@platform/agent-core";
import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import { AgentPage, NotConfigured } from "../components.tsx";
import { relativeAge } from "../format.ts";
import {
  editablePrompts,
  MAX_PROMPT_CHARS,
  type PromptKind,
  resetPrompt,
  savePrompt,
} from "../repository.ts";

/**
 * Editing what the summariser is asked to do.
 *
 * These are the two instructions that decide what a summary is *about* — the
 * hourly briefing and the catch-up. They live in the database rather than in
 * the build because the useful edits are the ones you think of while reading a
 * summary that missed something, and a redeploy between having the thought and
 * testing it is enough friction that the thought does not get tested.
 *
 * The compiled-in defaults stay authoritative: an empty field, or text equal to
 * the default, deletes the override rather than storing a copy. So the code is
 * always the baseline, and "reset" is a delete.
 *
 * Two textareas and two submit buttons, no client JavaScript — the platform
 * serves `script-src 'none'`, so each form posts natively and redirects.
 */

const LABELS: Record<PromptKind, { title: string; blurb: string }> = {
  hourly: {
    title: "hourly briefing",
    blurb:
      "Used for every scheduled window, and for each window inside a catch-up. This is where to say what you want noticed — hosts contacted, files written, credentials read.",
  },
  recap: {
    title: "catch-up",
    blurb:
      "Added on top of the hourly prompt when accounting for several hours at once. This is where to say how to weigh the period as a whole rather than hour by hour.",
  },
};

const isKind = (value: string): value is PromptKind => value === "hourly" || value === "recap";

export function createPromptRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    const config = agentConfig();
    if (!config) return c.html(<NotConfigured />);

    const prompts = await editablePrompts();
    const now = new Date();
    const saved = c.req.query("saved");

    return c.html(
      <AgentPage>
        <p class="text-muted text-sm">
          <a href="/agent">← overview</a>
        </p>

        <p class="mt-6 text-muted text-sm">
          Detail — how much the summariser reads and how long it writes — is set per deployment, not
          here. Hourly runs at <code>{config.AGENT_SUMMARY_DETAIL}</code> (
          {BUDGETS[config.AGENT_SUMMARY_DETAIL].sampleSize} prompts sampled,{" "}
          {BUDGETS[config.AGENT_SUMMARY_DETAIL].maxToolCalls} lookups); catch-up runs at{" "}
          <code>{config.AGENT_CATCHUP_DETAIL}</code> (
          {BUDGETS[config.AGENT_CATCHUP_DETAIL].sampleSize} sampled,{" "}
          {BUDGETS[config.AGENT_CATCHUP_DETAIL].maxToolCalls} lookups).
        </p>

        {saved && isKind(saved) ? <p class="mt-4 text-sm">saved · {LABELS[saved].title}</p> : null}

        {prompts.map((prompt) => (
          <section key={prompt.kind} class="mt-10">
            <hr class="mb-6" />

            <header class="flex flex-wrap items-baseline justify-between gap-x-4">
              <h2>{LABELS[prompt.kind].title}</h2>
              <span class="text-muted text-sm">
                {prompt.isDefault
                  ? "default"
                  : `edited ${prompt.updatedAt ? relativeAge(prompt.updatedAt, now) : ""}`}
              </span>
            </header>

            <p class="mt-2 text-muted text-sm">{LABELS[prompt.kind].blurb}</p>

            <form method="post" action={`/agent/prompts/${prompt.kind}`} class="mt-4">
              <textarea
                name="body"
                rows={18}
                maxlength={MAX_PROMPT_CHARS}
                spellcheck={false}
                class="w-full resize-y border border-current/20 p-3 font-mono text-sm leading-relaxed"
              >
                {prompt.body}
              </textarea>

              <div class="mt-3 flex items-center gap-x-6">
                <button type="submit" class="cursor-pointer underline hover:no-underline">
                  save
                </button>
                {prompt.isDefault ? (
                  <span class="text-muted text-sm">unchanged from the default</span>
                ) : (
                  <button
                    type="submit"
                    name="reset"
                    value="1"
                    class="cursor-pointer text-muted text-sm underline hover:no-underline"
                  >
                    reset to default
                  </button>
                )}
              </div>
            </form>
          </section>
        ))}
      </AgentPage>,
    );
  });

  routes.post("/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!isKind(kind)) return c.notFound();

    const form = await c.req.parseBody();

    // Both buttons submit the same form; the named one carries a value. Reading
    // the reset button rather than a separate route keeps the textarea's
    // contents from being lost if the browser resubmits.
    if (form.reset) {
      await resetPrompt(kind);
      return c.redirect(`/agent/prompts?saved=${kind}`, 303);
    }

    await savePrompt(kind, String(form.body ?? ""));
    return c.redirect(`/agent/prompts?saved=${kind}`, 303);
  });

  return routes;
}
