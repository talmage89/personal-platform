import { type AgentConfig, tableRef } from "./config.ts";
import type { Call, Window } from "./types.ts";

/**
 * A very small BigQuery client, spoken over REST with `fetch`.
 *
 * The official client library pulls in gRPC and its own auth stack, which is a
 * large dependency to bundle into a 43 MB image for the sake of one query
 * shape. What we actually need is a POST, a poll, and a row decoder — about a
 * hundred lines — so that is what this is.
 */

const BASE = "https://bigquery.googleapis.com/bigquery/v2";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Per-call cap on the logged request payload. Enough to see what was asked. */
const EXCERPT_CHARS = 2_000;

/**
 * Upper bound on rows pulled into memory for one window. An hour of ordinary
 * traffic is far below this; a window that hits the cap is itself a finding,
 * and `truncated` says so rather than the summary quietly describing a slice.
 */
const ROW_LIMIT = 5_000;

let tokenCache: { token: string; expiresAt: number } | undefined;

/**
 * A read-only access token for the ambient service account.
 *
 * On Cloud Run this comes from the metadata server, so no key material exists
 * anywhere on disk or in the environment. The env var is a local-development
 * escape hatch only — there is no metadata server on a laptop.
 */
async function accessToken(config: AgentConfig): Promise<string> {
  if (config.AGENT_LOGS_ACCESS_TOKEN) return config.AGENT_LOGS_ACCESS_TOKEN;

  // A minute of headroom: a token that expires between this check and the
  // request it authorises produces a 401 that looks like a permissions bug.
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const res = await fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) {
    throw new Error(`metadata server refused a token: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

/** Clears the token memo. Tests only. */
export function resetTokenCache(): void {
  tokenCache = undefined;
}

interface QueryParameter {
  name: string;
  parameterType: { type: string };
  parameterValue: { value: string };
}

interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId: string; location?: string };
  schema?: { fields: { name: string }[] };
  rows?: { f: { v: string | null }[] }[];
  pageToken?: string;
  totalBytesProcessed?: string;
  errors?: { message: string }[];
}

async function post(config: AgentConfig, sql: string, params: QueryParameter[]) {
  const token = await accessToken(config);

  const res = await fetch(`${BASE}/projects/${config.AGENT_LOGS_PROJECT}/queries`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      parameterMode: "NAMED",
      queryParameters: params,
      location: config.AGENT_LOGS_LOCATION,
      // Long enough that the common case returns inline; the poll below covers
      // the rest rather than this being tuned to always win.
      timeoutMs: 30_000,
      maxResults: 2_000,
    }),
  });

  if (!res.ok) throw new Error(`bigquery query failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as QueryResponse;
}

async function fetchPage(
  config: AgentConfig,
  jobId: string,
  pageToken?: string,
): Promise<QueryResponse> {
  const token = await accessToken(config);
  const url = new URL(`${BASE}/projects/${config.AGENT_LOGS_PROJECT}/queries/${jobId}`);
  url.searchParams.set("location", config.AGENT_LOGS_LOCATION);
  url.searchParams.set("maxResults", "2000");
  url.searchParams.set("timeoutMs", "30000");
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`bigquery poll failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as QueryResponse;
}

const SQL = (table: string) => `
SELECT
  trace.id                                        AS traceId,
  trace.timestamp                                 AS at,
  IFNULL(o.model, '(unknown)')                    AS model,
  IFNULL(o.providerSlug, '(unknown)')             AS provider,
  IFNULL(o.promptTokens, 0)                       AS promptTokens,
  IFNULL(o.completionTokens, 0)                   AS completionTokens,
  IFNULL(o.totalTokens, 0)                        AS totalTokens,
  IFNULL(o.totalCost, 0.0)                        AS costUsd,
  IFNULL(o.level, 'DEFAULT')                      AS level,
  o.statusCode                                    AS statusCode,
  IFNULL(o.normalizedFinishReason, o.finishReason) AS finishReason,
  SUBSTR(TO_JSON_STRING(trace.input), 1, @excerpt) AS inputExcerpt
FROM ${table}, UNNEST(trace.observations) AS o
WHERE dt BETWEEN @dtStart AND @dtEnd
  AND trace.timestamp >= @start
  AND trace.timestamp <  @end
ORDER BY trace.timestamp
LIMIT @rowLimit
`;

const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Every model call in a window, oldest first.
 *
 * The `dt` bounds are not redundant with the timestamp filter. The table is
 * partitioned on `dt` and declared with `require_hive_partition_filter`, so a
 * query without them is rejected outright — which is deliberate: it makes an
 * accidental full-bucket scan impossible to write. The window may straddle
 * midnight, hence a range rather than an equality.
 */
export async function fetchCalls(
  config: AgentConfig,
  window: Window,
): Promise<{ calls: Call[]; truncated: boolean; bytesProcessed: number }> {
  const params: QueryParameter[] = [
    {
      name: "dtStart",
      parameterType: { type: "DATE" },
      parameterValue: { value: day(window.start) },
    },
    { name: "dtEnd", parameterType: { type: "DATE" }, parameterValue: { value: day(window.end) } },
    {
      name: "start",
      parameterType: { type: "TIMESTAMP" },
      parameterValue: { value: window.start.toISOString() },
    },
    {
      name: "end",
      parameterType: { type: "TIMESTAMP" },
      parameterValue: { value: window.end.toISOString() },
    },
    {
      name: "excerpt",
      parameterType: { type: "INT64" },
      parameterValue: { value: String(EXCERPT_CHARS) },
    },
    {
      name: "rowLimit",
      parameterType: { type: "INT64" },
      parameterValue: { value: String(ROW_LIMIT) },
    },
  ];

  let page = await post(config, SQL(tableRef(config)), params);
  const bytesProcessed = Number(page.totalBytesProcessed ?? 0);

  if (page.errors?.length) {
    throw new Error(`bigquery: ${page.errors.map((e) => e.message).join("; ")}`);
  }

  const jobId = page.jobReference?.jobId;
  const calls: Call[] = [];

  for (;;) {
    // A query that has not finished returns no rows *and* no error, which reads
    // exactly like an empty window. Poll rather than mistake one for the other.
    if (!page.jobComplete) {
      if (!jobId) throw new Error("bigquery returned an incomplete job with no job id");
      page = await fetchPage(config, jobId);
      continue;
    }

    const names = (page.schema?.fields ?? []).map((f) => f.name);
    for (const row of page.rows ?? []) calls.push(decode(names, row.f));

    if (!page.pageToken || !jobId) break;
    page = await fetchPage(config, jobId, page.pageToken);
  }

  return { calls, truncated: calls.length >= ROW_LIMIT, bytesProcessed };
}

function decode(names: string[], cells: { v: string | null }[]): Call {
  const at = (name: string): string | null => {
    const index = names.indexOf(name);
    return index === -1 ? null : (cells[index]?.v ?? null);
  };
  const num = (name: string): number => Number(at(name) ?? 0) || 0;

  return {
    traceId: at("traceId") ?? "",
    // TIMESTAMP comes back as epoch *seconds*, fractional part included.
    at: new Date(num("at") * 1000),
    model: at("model") ?? "(unknown)",
    provider: at("provider") ?? "(unknown)",
    promptTokens: num("promptTokens"),
    completionTokens: num("completionTokens"),
    totalTokens: num("totalTokens"),
    costUsd: num("costUsd"),
    level: at("level") ?? "DEFAULT",
    statusCode: at("statusCode"),
    finishReason: at("finishReason"),
    inputExcerpt: at("inputExcerpt") ?? "",
  };
}
