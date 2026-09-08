import { agentConfig, dispatchJob, jobDispatchEnabled } from "@platform/agent-core";
import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import { AgentPage, AskForm, NotConfigured, sessionOf, Turn } from "../components.tsx";
import { formatCost, relativeAge } from "../format.ts";
import { answerChat } from "../jobs.ts";
import {
  askInChat,
  chatList,
  chatThread,
  deleteChat,
  retryChat,
  startChat,
  trimQuestion,
} from "../repository.ts";

/**
 * Asking about the record rather than reading it.
 *
 * The summaries answer "what happened in this window". They cannot answer "has
 * it ever done this before" or "what does a normal Tuesday cost", because those
 * range across the whole record — and the record only gets longer. This page is
 * that second way in.
 *
 * Answering takes minutes: it reads the warehouse, and often several times. So
 * nothing is answered inside the request that asks. The question is stored, a
 * job is started, and the page reloads itself until the answer lands — which is
 * the only way to poll on a platform that serves `script-src 'none'`, and is
 * the same shape the catch-up button already uses.
 */

/** How long a dispatched answer is still worth describing as "thinking". */
const PATIENCE_MS = 15 * 60_000;

/** How often a waiting thread reloads. Long enough not to fight the scroll. */
const REFRESH_SECONDS = 6;

const isPending = (pendingSince: Date | null, now: Date): boolean =>
  pendingSince !== null && now.getTime() - pendingSince.getTime() < PATIENCE_MS;

/**
 * Hands the question to a job, or answers it here when there is nowhere to
 * hand it to.
 *
 * Inline is right on a laptop — no proxy is going to close the connection and
 * the wait is honest — and wrong everywhere else, which is exactly what
 * `jobDispatchEnabled` distinguishes. A dispatch failure is returned rather
 * than thrown so the thread can show why it is not thinking.
 */
async function startAnswer(chatId: string): Promise<string | null> {
  const config = agentConfig();
  if (!config) return "this deployment has no log source configured";

  try {
    if (jobDispatchEnabled(config)) {
      await dispatchJob(config, ["dist/job.js", "agent", "chat", chatId]);
      return null;
    }
    await answerChat(chatId);
    return null;
  } catch (error) {
    console.error("could not start an answer", error);
    return error instanceof Error ? error.message : "unknown error";
  }
}

export function createChatRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    if (!agentConfig()) return c.html(<NotConfigured />);

    const now = new Date();
    const chats = await chatList(sessionOf(c).sub);

    return c.html(
      <AgentPage>
        <p class="text-muted text-sm">
          <a href="/agent">← overview</a>
          <span class="text-muted"> · </span>
          <a href="/agent/memory">memory</a>
        </p>

        <p class="mt-6 text-muted text-sm">
          Ask about anything in the record — the summaries, the raw calls behind them, or how any of
          it compares with a week ago. An answer reads the warehouse and takes a few minutes.
        </p>

        <AskForm
          action="/agent/chat"
          label="ask"
          placeholder="what has it been spending money on this week?"
        />

        {chats.length === 0 ? null : (
          <ul class="mt-10">
            {chats.map((chat) => (
              <li key={chat.id} class="border-current/10 border-b">
                <a
                  href={`/agent/chat/${chat.id}`}
                  class="block py-3 no-underline hover:bg-current/5"
                >
                  <div class="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span>{chat.title}</span>
                    <span class="text-muted text-sm">
                      {isPending(chat.pendingSince, now)
                        ? "thinking…"
                        : chat.lastError
                          ? "failed"
                          : relativeAge(chat.updatedAt, now)}
                    </span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </AgentPage>,
    );
  });

  routes.post("/", async (c) => {
    if (!agentConfig()) return c.redirect("/agent/chat", 303);

    const form = await c.req.parseBody();
    const question = trimQuestion(String(form.question ?? ""));
    if (!question) return c.redirect("/agent/chat", 303);

    const chatId = await startChat(sessionOf(c).sub, question);
    await startAnswer(chatId);
    return c.redirect(`/agent/chat/${chatId}`, 303);
  });

  routes.get("/:id", async (c) => {
    if (!agentConfig()) return c.html(<NotConfigured />);

    const now = new Date();
    const chat = await chatThread(c.req.param("id"), sessionOf(c).sub);
    if (!chat) return c.notFound();

    const pending = isPending(chat.pendingSince, now);
    const abandoned = chat.pendingSince !== null && !pending;
    const spent = chat.turns.reduce((sum, turn) => sum + turn.costUsd, 0);

    return c.html(
      // Only while something is genuinely outstanding. A page that goes on
      // refreshing after the answer has landed fights the reader for the
      // scroll position, and on a gated route it also keeps the database awake.
      <AgentPage refreshSeconds={pending ? REFRESH_SECONDS : undefined}>
        <p class="text-muted text-sm">
          <a href="/agent/chat">← conversations</a>
        </p>

        {chat.turns.map((turn) => (
          <Turn key={turn.id} turn={turn} now={now} />
        ))}

        {pending ? (
          <p class="mt-6 text-muted text-sm">
            reading the logs — this takes a few minutes. The page reloads itself.
          </p>
        ) : null}

        {abandoned ? (
          <p class="mt-6 text-sm">
            ! that answer never arrived. It has had longer than the job is allowed to run, so it
            failed rather than is still working.
          </p>
        ) : null}

        {chat.lastError ? (
          <p class="mt-6 text-sm">! the last attempt failed: {chat.lastError}</p>
        ) : null}

        {pending ? null : (
          <>
            {abandoned || chat.lastError ? (
              <form method="post" action={`/agent/chat/${chat.id}/retry`} class="mt-4">
                <button type="submit" class="cursor-pointer underline hover:no-underline">
                  try that again
                </button>
              </form>
            ) : null}

            <AskForm action={`/agent/chat/${chat.id}`} label="ask" placeholder="follow up…" />
          </>
        )}

        <nav class="mt-10 flex justify-between border-current/10 border-t pt-4 text-sm">
          <span class="text-muted tabular-nums">
            {spent > 0 ? `this conversation has cost ${formatCost(spent)}` : ""}
          </span>
          <form method="post" action={`/agent/chat/${chat.id}/delete`}>
            <button type="submit" class="cursor-pointer text-muted underline hover:no-underline">
              delete
            </button>
          </form>
        </nav>
      </AgentPage>,
    );
  });

  routes.post("/:id", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const question = trimQuestion(String(form.question ?? ""));
    if (!question) return c.redirect(`/agent/chat/${id}`, 303);

    // Scoped to this person inside the repository, so an id from somewhere else
    // is a no-op rather than a way into someone else's thread.
    await askInChat(id, sessionOf(c).sub, question);
    await startAnswer(id);
    return c.redirect(`/agent/chat/${id}`, 303);
  });

  routes.post("/:id/retry", async (c) => {
    const id = c.req.param("id");
    if (await retryChat(id, sessionOf(c).sub)) await startAnswer(id);
    return c.redirect(`/agent/chat/${id}`, 303);
  });

  routes.post("/:id/delete", async (c) => {
    await deleteChat(c.req.param("id"), sessionOf(c).sub);
    return c.redirect("/agent/chat", 303);
  });

  return routes;
}
