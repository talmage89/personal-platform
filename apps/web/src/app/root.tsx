import { raw } from "hono/html";
import type { PropsWithChildren } from "hono/jsx";

interface RootProps {
  title?: string;
}

export function Root({ title, children }: PropsWithChildren<RootProps>) {
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
