import { agentConfig } from "@platform/agent-core";
import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import { AgentPage, NotConfigured } from "../components.tsx";
import { relativeAge } from "../format.ts";
import {
  deleteNote,
  MAX_NOTE_BODY_CHARS,
  MAX_NOTE_SUMMARY_CHARS,
  notes,
  saveNote,
} from "../repository.ts";

/**
 * What the chat has decided is worth carrying between conversations.
 *
 * Visible and editable, which is the whole point of putting it on a page. A
 * memory nobody can see is a set of assertions that get repeated with growing
 * confidence and never checked — so every note is shown in full, every note can
 * be corrected by hand, and a wrong one can be deleted by the person it would
 * otherwise mislead.
 *
 * Writing here is deliberately as easy as reading: a note added by hand is
 * indistinguishable from one the model wrote, which makes this also the place
 * to tell it something it has no way to discover — what the agent is *for*,
 * which of its habits are intentional, what you have already decided not to
 * worry about.
 */

export function createMemoryRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    if (!agentConfig()) return c.html(<NotConfigured />);

    const now = new Date();
    const rows = await notes();
    const saved = c.req.query("saved");

    return c.html(
      <AgentPage>
        <p class="text-muted text-sm">
          <a href="/agent">← overview</a>
          <span class="text-muted"> · </span>
          <a href="/agent/chat">conversations</a>
        </p>

        <p class="mt-6 text-muted text-sm">
          Notes the conversation keeps between sessions. Each summary line is in the prompt of every
          conversation; the body is read when it matters. Anything you write here is read the same
          way — this is where to say what the agent is for, and what you have already decided not to
          worry about.
        </p>

        {saved ? <p class="mt-4 text-sm">saved · {saved}</p> : null}

        <section class="mt-10">
          <hr class="mb-6" />
          <h2>add a note</h2>
          <NoteForm />
        </section>

        {rows.length === 0 ? (
          <p class="mt-10 text-muted text-sm">Nothing remembered yet.</p>
        ) : (
          rows.map((note) => (
            <section key={note.key} class="mt-10">
              <hr class="mb-6" />
              <header class="flex flex-wrap items-baseline justify-between gap-x-4">
                <h2>
                  <code>{note.key}</code>
                </h2>
                <span class="text-muted text-sm">
                  {note.sourceChatId ? "written by a conversation · " : "written by hand · "}
                  {relativeAge(note.updatedAt, now)}
                </span>
              </header>
              <NoteForm note={note} />
            </section>
          ))
        )}
      </AgentPage>,
    );
  });

  routes.post("/", async (c) => {
    const form = await c.req.parseBody();
    const key = String(form.key ?? "");

    if (form.delete) {
      await deleteNote(key);
      return c.redirect("/agent/memory", 303);
    }

    // A note edited on this page is a note a person now stands behind, so the
    // conversation that first wrote it stops being credited for it.
    const stored = await saveNote({
      key,
      summary: String(form.summary ?? ""),
      body: String(form.body ?? ""),
      sourceChatId: null,
    });

    return c.redirect(stored ? `/agent/memory?saved=${stored}` : "/agent/memory", 303);
  });

  return routes;
}

/** One note, or an empty one. The same form either way — saving is an upsert. */
function NoteForm({ note }: { note?: { key: string; summary: string; body: string } }) {
  return (
    <form method="post" action="/agent/memory" class="mt-4">
      {note ? (
        <input type="hidden" name="key" value={note.key} />
      ) : (
        <input
          type="text"
          name="key"
          required
          placeholder="a-stable-handle"
          class="w-full border border-current/20 p-2 font-mono text-sm"
        />
      )}

      <input
        type="text"
        name="summary"
        required
        maxlength={MAX_NOTE_SUMMARY_CHARS}
        value={note?.summary ?? ""}
        placeholder="one line, carrying the fact itself"
        class={`w-full border border-current/20 p-2 text-sm ${note ? "" : "mt-3"}`}
      />

      <textarea
        name="body"
        rows={6}
        maxlength={MAX_NOTE_BODY_CHARS}
        placeholder="the detail, and how it was established"
        class="mt-3 w-full resize-y border border-current/20 p-3 text-sm leading-relaxed"
      >
        {note?.body ?? ""}
      </textarea>

      <div class="mt-3 flex items-center gap-x-6">
        <button type="submit" class="cursor-pointer underline hover:no-underline">
          save
        </button>
        {note ? (
          <button
            type="submit"
            name="delete"
            value="1"
            class="cursor-pointer text-muted text-sm underline hover:no-underline"
          >
            forget it
          </button>
        ) : null}
      </div>
    </form>
  );
}
