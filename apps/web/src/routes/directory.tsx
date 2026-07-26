import { Layout } from "@platform/ui";
import type { Utility } from "@platform/utility-kit";

/**
 * What replaces the landing page once you are signed in. Rendered from the same
 * array that mounts the routes, so a listed utility is always a reachable one.
 */
export function Directory({ utilities }: { utilities: readonly Utility[] }) {
  return (
    <Layout title="index" back={false}>
      {utilities.length === 0 ? (
        <p class="text-muted">No utilities yet.</p>
      ) : (
        <ul>
          {utilities.map((utility) => (
            <li key={utility.slug} class="mb-2">
              <a href={`/${utility.slug}`}>{utility.name}</a>
              <span class="ml-2 text-muted text-sm">{utility.blurb}</span>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}
