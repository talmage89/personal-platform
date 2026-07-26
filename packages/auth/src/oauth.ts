import { z } from "zod";

/**
 * GitHub OAuth, identity only.
 *
 * No database is involved at any point. The callback compares the returned
 * numeric user id against ALLOWED_GITHUB_ID from the environment, so an attacker
 * hammering these endpoints burns CPU and nothing else — they cannot wake Neon.
 * That property is why OAuth was chosen over a credential store.
 */

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

/**
 * Empty. GitHub returns the authenticated user's public profile — including the
 * numeric id, which is all we need — for a token with no scopes at all. There is
 * no reason to hold read access to this account's repositories.
 */
const SCOPE = "";

const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "personal-platform";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildAuthorizeUrl(config: OAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

const tokenSchema = z.object({ access_token: z.string().min(1) });
const userSchema = z.object({ id: z.number().int().positive() });

/** Returns an access token, or null on any failure. */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
): Promise<string | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) return null;

    // GitHub answers 200 with {error: "bad_verification_code"} on failure,
    // so the status alone proves nothing — the shape has to be checked.
    const parsed = tokenSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.access_token : null;
  } catch {
    return null;
  }
}

/** Returns the numeric GitHub user id as a string, or null on any failure. */
export async function fetchGitHubUserId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USER_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const parsed = userSchema.safeParse(await res.json());
    return parsed.success ? String(parsed.data.id) : null;
  } catch {
    return null;
  }
}
