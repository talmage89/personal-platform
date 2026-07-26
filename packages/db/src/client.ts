import { env } from "@platform/core";
import { PrismaNeonHttp } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client.ts";

/**
 * The database is reached through a function, never a module-level constant.
 *
 * This is the load-bearing detail of the whole architecture. Neon bills
 * compute-hours and this site is public, so the database must stay asleep until
 * a signed-in request genuinely needs data. Constructing a PrismaClient opens no
 * socket — the first *query* does — and because construction only happens inside
 * db(), and db() is only called from utility repositories behind the session
 * gate, boot is cold and stays cold.
 *
 * Never export a ready-made client from this file. `export const db = new
 * PrismaClient(...)` would be the one line that quietly undoes it.
 */

let client: PrismaClient | undefined;

/**
 * Neon's HTTP driver rather than the WebSocket pool, deliberately.
 *
 * A live pool socket holds the Neon compute *awake*, which is the largest
 * free-tier waster there is. HTTP is request-scoped, so the compute suspends on
 * its idle timer. It also drops the `ws` dependency from the bundle.
 *
 * The trade is no interactive transactions. `$transaction([...])` batch form
 * still works, which is enough for utilities that write a row at a time.
 */
function createAdapter(url: string) {
  const isNeon = url.includes("neon.tech");
  return isNeon ? new PrismaNeonHttp(url, {}) : new PrismaPg({ connectionString: url });
}

export function db(): PrismaClient {
  if (!client) {
    client = new PrismaClient({ adapter: createAdapter(env().DB_URL) });
  }
  return client;
}

/** Which driver a URL selects. Exported for tests; the choice is not configurable. */
export const adapterFor = (url: string): "neon-http" | "pg" =>
  url.includes("neon.tech") ? "neon-http" : "pg";

/** Closes the connection if one was ever opened. Tests and shutdown hooks only. */
export async function disconnect(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
