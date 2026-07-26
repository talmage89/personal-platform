/**
 * The public face.
 *
 * A fixed set of stanzas with the day selecting one. Deterministic, so the page
 * stays cacheable for a day at a time; no storage, no randomness, no database.
 * It rewards a second visit without ever explaining itself.
 */

export const STANZAS: readonly (readonly string[])[] = [
  ["the ledger keeps", "what the body forgets"],
  ["everything past this door is counted.", "nothing past this door is yours."],
  ["a room with one entrance", "and no windows —", "the door is not for knocking"],
  ["some numbers mean nothing", "except to the hand", "that wrote them down"],
  ["there is a machine behind this page.", "it is doing arithmetic", "about a stranger."],
  ["come back tomorrow.", "it will say something else."],
  ["measurement is a kind of attention.", "attention is a kind of care.", "neither is on display."],
];

/** Days elapsed since the Unix epoch, in UTC. Stable across time zones. */
function epochDay(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000,
  );
}

export function stanzaForDate(date: Date = new Date()): readonly string[] {
  const index = epochDay(date) % STANZAS.length;
  return STANZAS[index] as readonly string[];
}

/** Seconds until the next UTC midnight — how long today's stanza stays correct. */
export function secondsUntilRollover(date: Date = new Date()): number {
  const nextMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.floor((nextMidnight - date.getTime()) / 1000));
}
