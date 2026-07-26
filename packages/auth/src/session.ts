import { Buffer } from "node:buffer";
import { z } from "zod";

/**
 * Sessions are stateless: the cookie carries its own proof.
 *
 * This is load-bearing, not a convenience. A session *table* would mean every
 * authenticated request begins with a database lookup, which would wake Neon on
 * any stray request carrying a stale cookie. Verification here is a hash, so the
 * database stays asleep until a utility genuinely needs data.
 *
 * Format: base64url(payload).base64url(hmac-sha256 over the encoded payload)
 *
 * Rotating SESSION_SECRET invalidates every session everywhere — it is the
 * log-out-all-devices button, and the only revocation mechanism there is.
 */

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const payloadSchema = z.object({
  sub: z.string().min(1), // GitHub numeric user id
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

export type SessionPayload = z.infer<typeof payloadSchema>;

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;

  const key = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  keyCache.set(secret, key);
  return key;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export async function signSession(
  sub: string,
  secret: string,
  issuedAt: number = nowSeconds(),
): Promise<string> {
  const payload: SessionPayload = {
    sub,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(encoded),
  );

  return `${encoded}.${Buffer.from(signature).toString("base64url")}`;
}

/**
 * Returns the payload, or null for *any* failure — bad shape, bad signature,
 * expired, wrong secret. Callers get no detail, deliberately: a caller that
 * could distinguish "expired" from "forged" would leak that distinction onward.
 */
export async function verifySession(
  token: string | undefined,
  secret: string,
  at: number = nowSeconds(),
): Promise<SessionPayload | null> {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts as [string, string];
  if (!encoded || !signature) return null;

  let valid: boolean;
  try {
    // subtle.verify does the comparison itself, so there is no hand-rolled
    // (and potentially timing-variable) equality check anywhere in this path.
    valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      Buffer.from(signature, "base64url"),
      encoder.encode(encoded),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  const parsed = (() => {
    try {
      return payloadSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString()));
    } catch {
      return null;
    }
  })();

  if (!parsed?.success) return null;
  if (parsed.data.exp <= at) return null;

  return parsed.data;
}
