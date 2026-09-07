import { accessToken } from "./bigquery.ts";
import { type AgentConfig, jobDispatchEnabled } from "./config.ts";

/**
 * Starting the heavy work somewhere a request cannot follow it.
 *
 * The catch-up is the one thing this utility does that takes minutes rather
 * than seconds, and for a while it was done inside the POST that asked for it.
 * That never worked and could not be made to: the server closes a connection
 * that has sent nothing for ten seconds, so the browser was shown a failure
 * roughly twelve seconds in while the summary carried on being written, and
 * paid for, and then discarded when nothing was left to return it to.
 *
 * Raising that idle limit only moves the cliff — it is capped in the low
 * hundreds of seconds, and a deep catch-up can outlast that honestly. So the
 * button stops waiting altogether. It starts the same job the scheduler
 * already runs, on the same image, and returns immediately; the result arrives
 * on the page and as a push when the job is done.
 */

/** Region-scoped, because a job only exists in the region that holds it. */
const runApi = (region: string) => `https://${region}-run.googleapis.com/v2`;

/**
 * How long to wait for the job to be *accepted*. This is not the job's own
 * budget — the call returns as soon as the execution is created, and the work
 * outlives it by minutes.
 */
const ACCEPT_TIMEOUT_MS = 15_000;

export class DispatchError extends Error {}

/**
 * Starts one execution of the configured job with the given arguments.
 *
 * Arguments are overridden per execution rather than baked into a second job
 * resource, so the scheduled run and the on-demand run stay the same
 * deployment artifact: one image, one job, one place where a bad build shows
 * up. The identity running the service needs `run.jobs.runWithOverrides` on
 * that job — plain `run.invoker` is not enough, which is a permission error
 * worth recognising rather than rediscovering.
 *
 * Returns the execution's name, which is what the logs are keyed by.
 */
export async function dispatchJob(config: AgentConfig, args: string[]): Promise<string> {
  if (!jobDispatchEnabled(config)) {
    throw new DispatchError("no job configured to dispatch to");
  }

  const { AGENT_JOB_PROJECT: project, AGENT_JOB_REGION: region, AGENT_JOB_NAME: job } = config;
  const url = `${runApi(region)}/projects/${project}/locations/${region}/jobs/${job}:run`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken(config)}`,
      "Content-Type": "application/json",
    },
    // `args` replaces the container's own arguments; the entrypoint command is
    // left alone. Everything else about the execution — image, memory, timeout,
    // environment — is whatever the job was deployed with.
    body: JSON.stringify({ overrides: { containerOverrides: [{ args }] } }),
    signal: AbortSignal.timeout(ACCEPT_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new DispatchError(
      `could not start the job: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }

  const body = (await res.json()) as { metadata?: { name?: string }; name?: string };
  return body.metadata?.name ?? body.name ?? "started";
}
