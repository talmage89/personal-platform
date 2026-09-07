import { env } from "@platform/core";
import { utilities } from "~/utilities.ts";

/**
 * The scheduled entrypoint. Same image as the server, different process.
 *
 * Scheduled work used to arrive as an HTTP request to the running service,
 * which meant every summary had to finish inside a request timeout — and an
 * agentic summary that reads around the window cannot promise that. As a job
 * there is no request behind it and no timeout to beat: the work is bounded by
 * its own deadline, in code, where the reason for the bound is visible.
 *
 * Usage: `bun dist/job.js <utility-slug> <job-name>`
 *
 * No explicit database disconnect on the way out, and no `@platform/db` import
 * to do it with. The Neon driver is HTTP and request-scoped, so there is no
 * pool socket to close, and `process.exit` ends anything a local Postgres
 * adapter might be holding. Importing the client here purely to shut it down
 * would give the web app a direct database dependency it does not otherwise
 * have — see the perimeter.
 */

// Fails fast on a misconfigured deploy, exactly as the server does. No socket
// is opened here — DB_URL is validated for shape only.
env();

const [slug, name] = process.argv.slice(2);

if (!slug || !name) {
  console.error("usage: job <utility-slug> <job-name>");
  process.exit(2);
}

const utility = utilities.find((u) => u.slug === slug);
const run = utility?.jobs?.[name];

if (!run) {
  // Exit 2 rather than 1: "this job does not exist" is a deployment mistake and
  // should not read like "the job ran and failed", which a scheduler retries.
  console.error(`no such job: ${slug}/${name}`);
  process.exit(2);
}

const started = Date.now();

try {
  const result = await run();
  console.log(`${slug}/${name}: ${result} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  process.exit(0);
} catch (error) {
  console.error(`${slug}/${name} failed after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.error(error);
  process.exit(1);
}
