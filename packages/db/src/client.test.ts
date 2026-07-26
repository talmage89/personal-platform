import { describe, expect, test } from "bun:test";
import { adapterFor, db, disconnect } from "./client.ts";

/**
 * The guarantee under test: importing this package, and even constructing the
 * client, must not open a connection. Only a query may.
 *
 * These run against a DB_URL pointed at a closed port, so anything that
 * connected eagerly would fail here rather than in production, on the bill.
 */

const BLACK_HOLE = "postgresql://nobody:nobody@127.0.0.1:1/nothing";

describe("adapter selection", () => {
  test("uses the neon http driver for neon urls", () => {
    // Not the WebSocket pool: a live socket holds the Neon compute awake, which
    // is the single largest free-tier waster.
    const neon = "postgresql://u:p@ep-x-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require";
    expect(adapterFor(neon)).toBe("neon-http");
  });

  test("uses node-postgres for everything else", () => {
    expect(adapterFor("postgresql://platform@localhost:5432/platform")).toBe("pg");
    expect(adapterFor(BLACK_HOLE)).toBe("pg");
  });
});

describe("laziness", () => {
  test("constructing the client opens no connection", async () => {
    process.env.DB_URL = BLACK_HOLE;
    process.env.SESSION_SECRET = "t".repeat(48);

    // If this connected eagerly it would throw or hang against a closed port.
    const started = performance.now();
    const client = db();
    const elapsed = performance.now() - started;

    expect(client).toBeDefined();
    expect(elapsed).toBeLessThan(500);

    await disconnect();
  });

  test("returns the same instance on repeat calls", async () => {
    process.env.DB_URL = BLACK_HOLE;
    expect(db()).toBe(db());
    await disconnect();
  });
});
