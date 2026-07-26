import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { SESSION_TTL_SECONDS, signSession, verifySession } from "./session.ts";

const SECRET = "a".repeat(48);
const OTHER = "b".repeat(48);
const NOW = 1_800_000_000;

describe("session", () => {
  test("round-trips a subject", async () => {
    const token = await signSession("583231", SECRET, NOW);
    const payload = await verifySession(token, SECRET, NOW + 10);
    expect(payload?.sub).toBe("583231");
  });

  test("sets a 30 day expiry", async () => {
    const token = await signSession("1", SECRET, NOW);
    const payload = await verifySession(token, SECRET, NOW);
    expect(payload?.exp).toBe(NOW + SESSION_TTL_SECONDS);
  });

  test("rejects a token signed with a different secret", async () => {
    // Rotating SESSION_SECRET is the only revocation mechanism, so this is the
    // test that guarantees rotation actually logs everyone out.
    const token = await signSession("1", OTHER, NOW);
    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  });

  test("rejects an expired token", async () => {
    const token = await signSession("1", SECRET, NOW);
    expect(await verifySession(token, SECRET, NOW + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  test("rejects a token expiring exactly now", async () => {
    const token = await signSession("1", SECRET, NOW);
    expect(await verifySession(token, SECRET, NOW + SESSION_TTL_SECONDS)).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const token = await signSession("1", SECRET, NOW);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "999", iat: NOW, exp: NOW + 1000 })).toString(
      "base64url",
    );
    expect(await verifySession(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  test("rejects a stripped signature", async () => {
    const token = await signSession("1", SECRET, NOW);
    const [encoded] = token.split(".");
    expect(await verifySession(encoded, SECRET, NOW)).toBeNull();
    expect(await verifySession(`${encoded}.`, SECRET, NOW)).toBeNull();
  });

  test("rejects junk", async () => {
    for (const junk of ["", "...", "nonsense", "a.b.c", "%%%.%%%"]) {
      expect(await verifySession(junk, SECRET, NOW)).toBeNull();
    }
  });

  test("rejects a missing token", async () => {
    expect(await verifySession(undefined, SECRET, NOW)).toBeNull();
  });

  test("rejects a validly signed payload of the wrong shape", async () => {
    // Signature is genuine; the contents are not a session. Must still fail.
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const encoded = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url");
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(encoded));
    const token = `${encoded}.${Buffer.from(sig).toString("base64url")}`;

    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  });
});
