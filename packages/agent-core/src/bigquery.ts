import { type AgentConfig, selfKeyNames, tableRef } from "./config.ts";
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

/** Characters of dialog per call in the window read and in a search hit. */
const SEARCH_EXCERPT_CHARS = 4_000;

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
  parameterType: { type: string; arrayType?: { type: string } };
  parameterValue: { value?: string; arrayValues?: { value: string }[] };
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

/**
 * Runs one query to completion and returns decoded rows keyed by column name.
 *
 * Factored out because there are now three query shapes — the window read and
 * the two exploration tools — and the polling and paging below is the part that
 * is easy to get subtly wrong once, let alone three times.
 */
async function runQuery(
  config: AgentConfig,
  sql: string,
  params: QueryParameter[],
  rowLimit: number,
): Promise<{ rows: Record<string, string | null>[]; truncated: boolean; bytesProcessed: number }> {
  let page = await post(config, sql, params);
  const bytesProcessed = Number(page.totalBytesProcessed ?? 0);

  if (page.errors?.length) {
    throw new Error(`bigquery: ${page.errors.map((e) => e.message).join("; ")}`);
  }

  const jobId = page.jobReference?.jobId;
  const rows: Record<string, string | null>[] = [];

  for (;;) {
    // A query that has not finished returns no rows *and* no error, which reads
    // exactly like an empty result. Poll rather than mistake one for the other.
    if (!page.jobComplete) {
      if (!jobId) throw new Error("bigquery returned an incomplete job with no job id");
      page = await fetchPage(config, jobId);
      continue;
    }

    const names = (page.schema?.fields ?? []).map((f) => f.name);
    for (const row of page.rows ?? []) {
      const record: Record<string, string | null> = {};
      names.forEach((name, i) => {
        record[name] = row.f[i]?.v ?? null;
      });
      rows.push(record);
    }

    if (!page.pageToken || !jobId) break;
    page = await fetchPage(config, jobId, page.pageToken);
  }

  return { rows, truncated: rows.length >= rowLimit, bytesProcessed };
}

/**
 * Which observations are actually model calls, and whose.
 *
 * `type = 'GENERATION'` — a trace carries SPAN observations alongside the
 * generation, two of them per call in practice. Counting all of them inflated
 * the call count 3x (270 where there were 90), invented an `(unknown)` model
 * for the spans, and made the repetition detector fire on every window: spans
 * share their trace's input, so "consecutive identical prompts" was true by
 * construction. Verified against real data — with this filter, every hour's
 * prompts are distinct.
 *
 * The self-exclusion keys on `apiKeyName`, and on nothing else.
 *
 * It first used a marker in the request's `user` field, which the broker does
 * not persist — zero rows carry it. The obvious next guess, excluding the
 * summariser's own model, is *worse than useless*: the agent being watched may
 * run the same model as the summariser, and here it does, so that filter
 * removed 100% of the traffic it was supposed to report on. It shipped briefly
 * and is the reason this comment is long.
 *
 * A key name is the only thing in a trace that distinguishes who made the call
 * and cannot collide with a legitimate choice the agent makes. It is opt-in and
 * empty by default: configure it only once the summariser has a broker key of
 * its own, and until then nothing is excluded — over-reporting the summariser's
 * own traffic is a visible, cheap mistake, whereas silently dropping the
 * agent's is neither.
 */
const AT = "SAFE.TIMESTAMP(JSON_VALUE(trace, '$.timestamp'))";
const int64 = (path: string) => `IFNULL(SAFE_CAST(JSON_VALUE(o, '$.${path}') AS INT64), 0)`;
const COST = "IFNULL(SAFE_CAST(JSON_VALUE(o, '$.totalCost') AS FLOAT64), 0.0)";

/**
 * The excerpt: a little of the head, then the tail.
 *
 * It used to be the first N characters of the request payload, which for a
 * coding agent is the system prompt and nothing else. Every sampled call looked
 * identical, so the model spent its entire lookup budget discovering that the
 * previews were useless — it said so, in a stored summary: "the sampled
 * snippets only show the fixed system-prompt prefix, so the actual tool
 * activity stays invisible".
 *
 * The head is kept because it says what the agent was set up to do; the tail is
 * where what it actually just did lives — the latest turn and its tool results.
 * The middle is the part nobody needed.
 */
const HEAD_CHARS = 400;
const excerpt = (chars: number) => {
  const js = "TO_JSON_STRING(JSON_QUERY(trace, '$.input'))";
  return `IF(LENGTH(${js}) <= ${chars},
    ${js},
    CONCAT(SUBSTR(${js}, 1, ${HEAD_CHARS}), '\\n[…]\\n',
           SUBSTR(${js}, LENGTH(${js}) - ${chars - HEAD_CHARS} + 1)))`;
};

const ONLY_REAL_CALLS = `AND JSON_VALUE(o, '$.type') = 'GENERATION'
  AND NOT CONTAINS_SUBSTR(TO_JSON_STRING(trace), @selfMarker)
  AND IFNULL(JSON_VALUE(trace, '$.apiKeyName'), '') NOT IN UNNEST(@selfKeys)`;

const SQL = (table: string) => `
SELECT
  JSON_VALUE(trace, '$.id')                            AS traceId,
  ${AT}                                                AS \`at\`,
  IFNULL(JSON_VALUE(o, '$.model'), '(unknown)')        AS model,
  IFNULL(JSON_VALUE(o, '$.providerSlug'), '(unknown)') AS provider,
  ${int64("promptTokens")}                             AS promptTokens,
  ${int64("completionTokens")}                         AS completionTokens,
  ${int64("totalTokens")}                              AS totalTokens,
  ${COST}                                              AS costUsd,
  IFNULL(JSON_VALUE(o, '$.level'), 'DEFAULT')          AS level,
  JSON_VALUE(o, '$.statusCode')                        AS statusCode,
  IFNULL(JSON_VALUE(o, '$.normalizedFinishReason'), JSON_VALUE(o, '$.finishReason')) AS finishReason,
  ${excerpt(EXCERPT_CHARS)} AS inputExcerpt
FROM ${table}, UNNEST(JSON_QUERY_ARRAY(trace, '$.observations')) AS o
WHERE dt BETWEEN @dtStart AND @dtEnd
  AND ${AT} >= @start
  AND ${AT} <  @end
  ${ONLY_REAL_CALLS}
ORDER BY \`at\`
LIMIT @rowLimit
`;

/** Matching calls, with a longer excerpt than the window read carries. */
const SEARCH_SQL = (table: string) => `
SELECT
  JSON_VALUE(trace, '$.id')                     AS traceId,
  ${AT}                                         AS \`at\`,
  IFNULL(JSON_VALUE(o, '$.model'), '(unknown)') AS model,
  ${int64("promptTokens")}                      AS promptTokens,
  ${excerpt(EXCERPT_CHARS)} AS inputExcerpt
FROM ${table}, UNNEST(JSON_QUERY_ARRAY(trace, '$.observations')) AS o
WHERE dt BETWEEN @dtStart AND @dtEnd
  AND ${AT} >= @start
  AND ${AT} <  @end
  AND CONTAINS_SUBSTR(TO_JSON_STRING(JSON_QUERY(trace, '$.input')), @needle)
  ${ONLY_REAL_CALLS}
ORDER BY \`at\`
LIMIT @rowLimit
`;

/** One trace in full, for when an excerpt was not enough. */
const TRACE_SQL = (table: string) => `
SELECT SUBSTR(TO_JSON_STRING(trace), 1, @excerpt) AS body
FROM ${table}
WHERE dt BETWEEN @dtStart AND @dtEnd
  AND JSON_VALUE(trace, '$.id') = @traceId
LIMIT 1
`;

/**
 * Exact totals for a span, computed in the warehouse rather than in memory.
 *
 * The window read is capped at ROW_LIMIT rows, which is right for an hour and
 * wrong for a multi-day catch-up: past the cap the totals would silently
 * describe a slice. Aggregating in SQL is exact at any size and cheaper, so the
 * roll-up takes its numbers from here and uses the row read only for dialog.
 *
 * `isError` in stats.ts is `statusCode IS NOT NULL OR level != 'DEFAULT'`; the
 * COUNTIF below must stay identical to it or an hour and a day would disagree
 * about the same traffic.
 */
const AGGREGATE_SQL = (table: string) => `
SELECT
  IFNULL(JSON_VALUE(o, '$.model'), '(unknown)') AS model,
  COUNT(*)                                      AS calls,
  SUM(${int64("totalTokens")})                  AS totalTokens,
  SUM(${COST})                                  AS costUsd,
  COUNTIF(
    JSON_VALUE(o, '$.statusCode') IS NOT NULL
    OR IFNULL(JSON_VALUE(o, '$.level'), 'DEFAULT') != 'DEFAULT'
  )                                             AS errorCount,
  APPROX_QUANTILES(${int64("promptTokens")}, 2)[OFFSET(1)] AS medianPromptTokens
FROM ${table}, UNNEST(JSON_QUERY_ARRAY(trace, '$.observations')) AS o
WHERE dt BETWEEN @dtStart AND @dtEnd
  AND ${AT} >= @start
  AND ${AT} <  @end
  ${ONLY_REAL_CALLS}
GROUP BY model
ORDER BY calls DESC
`;

const day = (d: Date): string => d.toISOString().slice(0, 10);

const str = (name: string, value: string): QueryParameter => ({
  name,
  parameterType: { type: "STRING" },
  parameterValue: { value },
});

const strArray = (name: string, values: string[]): QueryParameter => ({
  name,
  parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
  parameterValue: { arrayValues: values.map((value) => ({ value })) },
});

const int = (name: string, value: number): QueryParameter => ({
  name,
  parameterType: { type: "INT64" },
  parameterValue: { value: String(value) },
});

/**
 * The `dt` bounds are not redundant with the timestamp filter. The table is
 * partitioned on `dt` and declared with `require_hive_partition_filter`, so a
 * query without them is rejected outright — which is deliberate: it makes an
 * accidental full-bucket scan impossible to write. A window may straddle
 * midnight, hence a range rather than an equality.
 */
function windowParams(window: Window): QueryParameter[] {
  return [
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
  ];
}

/** Every model call in a window, oldest first. */
export async function fetchCalls(
  config: AgentConfig,
  window: Window,
): Promise<{ calls: Call[]; truncated: boolean; bytesProcessed: number }> {
  const params = [
    ...windowParams(window),
    int("excerpt", EXCERPT_CHARS),
    int("rowLimit", ROW_LIMIT),
    str("selfMarker", config.AGENT_SELF_MARKER),
    strArray("selfKeys", selfKeyNames(config)),
  ];

  const { rows, truncated, bytesProcessed } = await runQuery(
    config,
    SQL(tableRef(config)),
    params,
    ROW_LIMIT,
  );

  return { calls: rows.map(decode), truncated, bytesProcessed };
}

/** Cap on one search. Wide enough to be useful, narrow enough to stay a probe. */
const SEARCH_LIMIT = 25;

export interface DialogHit {
  traceId: string;
  at: Date;
  model: string;
  promptTokens: number;
  excerpt: string;
}

/**
 * Calls in a window whose request payload contains `needle`.
 *
 * Substring rather than regex on purpose: this is reached through a tool call
 * made by a model, and a regex is both a way to write an accidental table scan
 * and a way to write one that never terminates. `CONTAINS_SUBSTR` is
 * case-insensitive, which is the behaviour someone searching for a hostname or
 * a filename would expect anyway.
 */
export async function searchDialog(
  config: AgentConfig,
  window: Window,
  needle: string,
  limit = SEARCH_LIMIT,
): Promise<{ hits: DialogHit[]; truncated: boolean }> {
  const capped = Math.max(1, Math.min(limit, SEARCH_LIMIT));
  const params = [
    ...windowParams(window),
    str("needle", needle),
    int("excerpt", SEARCH_EXCERPT_CHARS),
    int("rowLimit", capped),
    str("selfMarker", config.AGENT_SELF_MARKER),
    strArray("selfKeys", selfKeyNames(config)),
  ];

  const { rows, truncated } = await runQuery(config, SEARCH_SQL(tableRef(config)), params, capped);

  const hits = rows.map((row) => ({
    traceId: row.traceId ?? "",
    at: new Date(Number(row.at ?? 0) * 1000),
    model: row.model ?? "(unknown)",
    promptTokens: Number(row.promptTokens ?? 0) || 0,
    excerpt: row.inputExcerpt ?? "",
  }));

  return { hits, truncated };
}

/** Ceiling on one whole trace. Past this, a summary is transcribing, not reading. */
const TRACE_CHARS = 20_000;

/**
 * One trace in full, by id.
 *
 * Bounded by the same window the summary covers rather than by the id alone:
 * the partition filter is mandatory, and scoping the lookup to the window under
 * review also means a tool call cannot wander outside it.
 */
export async function fetchTrace(
  config: AgentConfig,
  window: Window,
  traceId: string,
): Promise<string | null> {
  const params = [
    ...windowParams(window).filter((p) => p.name === "dtStart" || p.name === "dtEnd"),
    str("traceId", traceId),
    int("excerpt", TRACE_CHARS),
  ];

  const { rows } = await runQuery(config, TRACE_SQL(tableRef(config)), params, 1);
  return rows[0]?.body ?? null;
}

function decode(row: Record<string, string | null>): Call {
  const num = (name: string): number => Number(row[name] ?? 0) || 0;

  return {
    traceId: row.traceId ?? "",
    // TIMESTAMP comes back as epoch *seconds*, fractional part included.
    at: new Date(num("at") * 1000),
    model: row.model ?? "(unknown)",
    provider: row.provider ?? "(unknown)",
    promptTokens: num("promptTokens"),
    completionTokens: num("completionTokens"),
    totalTokens: num("totalTokens"),
    costUsd: num("costUsd"),
    level: row.level ?? "DEFAULT",
    statusCode: row.statusCode ?? null,
    finishReason: row.finishReason ?? null,
    inputExcerpt: row.inputExcerpt ?? "",
  };
}

export interface SpanAggregate {
  callCount: number;
  costUsd: number;
  totalTokens: number;
  errorCount: number;
  /** Weighted by calls across models — close enough for a baseline reference. */
  medianPromptTokens: number;
  models: { model: string; calls: number; costUsd: number; totalTokens: number }[];
}

/** Exact per-model totals for a span, at any volume. */
export async function aggregateSpan(config: AgentConfig, window: Window): Promise<SpanAggregate> {
  const params = [
    ...windowParams(window),
    str("selfMarker", config.AGENT_SELF_MARKER),
    strArray("selfKeys", selfKeyNames(config)),
  ];

  const { rows } = await runQuery(
    config,
    AGGREGATE_SQL(tableRef(config)),
    params,
    Number.MAX_SAFE_INTEGER,
  );

  const models = rows.map((row) => ({
    model: row.model ?? "(unknown)",
    calls: Number(row.calls ?? 0) || 0,
    costUsd: Number(row.costUsd ?? 0) || 0,
    totalTokens: Number(row.totalTokens ?? 0) || 0,
  }));

  const callCount = models.reduce((sum, m) => sum + m.calls, 0);

  // Per-model medians cannot be merged into a true overall median without the
  // underlying values. Weighting by call count is an approximation, and it is
  // only ever used as a baseline reference point — never reported as a fact.
  const weighted = rows.reduce(
    (sum, row) => sum + (Number(row.medianPromptTokens ?? 0) || 0) * (Number(row.calls ?? 0) || 0),
    0,
  );

  return {
    callCount,
    costUsd: models.reduce((sum, m) => sum + m.costUsd, 0),
    totalTokens: models.reduce((sum, m) => sum + m.totalTokens, 0),
    errorCount: rows.reduce((sum, row) => sum + (Number(row.errorCount ?? 0) || 0), 0),
    medianPromptTokens: callCount === 0 ? 0 : Math.round(weighted / callCount),
    models,
  };
}
