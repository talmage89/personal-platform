import { raw } from "hono/html";
import type { PropsWithChildren } from "hono/jsx";

interface RootProps {
  title?: string;
  /**
   * Seconds after which the browser should reload this page, if it should.
   *
   * The one way to poll on a platform that serves `script-src 'none'`. A page
   * waiting on work that runs somewhere else — an answer being written by a job
   * — otherwise has no way to notice it has arrived, and "reload this yourself"
   * is an instruction people follow twice and then stop following.
   *
   * Only ever set while something is genuinely outstanding: a page that keeps
   * refreshing after the work has landed is a page that fights the reader for
   * the scroll position, and on a gated route it also keeps the database awake.
   */
  refreshSeconds?: number;
}

export function Root({ title, refreshSeconds, children }: PropsWithChildren<RootProps>) {
  return (
    <>
      {/*
        Hono does not emit a doctype for JSX responses, and without one the
        browser falls into quirks mode — which silently breaks the layout.
      */}
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <title>{title ?? ""}</title>
          {refreshSeconds ? <meta http-equiv="refresh" content={String(refreshSeconds)} /> : null}
          <link rel="stylesheet" href="/styles.css" />
          {/* An empty svg. A favicon request that 404s is a wasted round trip. */}
          <link
            rel="icon"
            href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/>"
          />
        </head>
        <body>{children}</body>
      </html>
    </>
  );
}
