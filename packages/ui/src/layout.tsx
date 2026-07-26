import type { PropsWithChildren } from "hono/jsx";
import { Root } from "./root.tsx";

interface LayoutProps {
  /** Page name, shown as the heading and in the tab. */
  title: string;
  /** Omitted on the directory itself, which is already home. */
  back?: boolean;
}

/**
 * The chrome every signed-in page wears. Lives here rather than in apps/web so
 * that utility packages can import it — a utility depending on the app that
 * mounts it would be a cycle.
 *
 * Deliberately thin: a heading, a rule, and a way out. The 640px column and the
 * element defaults in styles.css carry the rest, which is why utility pages need
 * almost no classes of their own.
 */
export function Layout({ title, back = true, children }: PropsWithChildren<LayoutProps>) {
  return (
    <Root title={title}>
      <header>
        <h1>
          {back ? (
            <a href="/" class="no-underline hover:underline">
              ←
            </a>
          ) : null}
          {back ? " " : null}
          {title}
        </h1>
        <hr />
      </header>

      <main>{children}</main>

      <footer class="mt-12">
        <hr />
        <form method="post" action="/auth/logout">
          <button type="submit" class="cursor-pointer underline hover:no-underline">
            leave
          </button>
        </form>
      </footer>
    </Root>
  );
}
