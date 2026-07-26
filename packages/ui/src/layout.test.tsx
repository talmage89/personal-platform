import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { HtmlEscapedString } from "hono/utils/html";
import { Layout } from "./layout.tsx";
import { Root } from "./root.tsx";

const render = async (node: HtmlEscapedString | Promise<HtmlEscapedString>): Promise<string> => {
  const app = new Hono().get("/", (c) => c.html(node));
  return (await app.request("/")).text();
};

describe("Root", () => {
  test("emits a doctype", async () => {
    // Without one the browser falls into quirks mode and the layout breaks
    // silently. Hono does not add it for JSX responses.
    const html = await render(<Root>content</Root>);
    expect(html.toLowerCase().startsWith("<!doctype html>")).toBe(true);
  });

  test("links the stylesheet and declares both colour schemes", async () => {
    const html = await render(<Root>content</Root>);
    expect(html).toContain('href="/styles.css"');
    expect(html).toContain('content="light dark"');
  });

  test("carries a title through", async () => {
    expect(await render(<Root title="weight">x</Root>)).toContain("<title>weight</title>");
  });
});

describe("Layout", () => {
  test("shows the title as the heading", async () => {
    expect(await render(<Layout title="weight">x</Layout>)).toContain("weight");
  });

  test("offers a way out", async () => {
    const html = await render(<Layout title="weight">x</Layout>);
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain('method="post"');
  });

  test("links back to the directory by default", async () => {
    expect(await render(<Layout title="weight">x</Layout>)).toContain('href="/"');
  });

  test("omits the back link when already home", async () => {
    const html = await render(
      <Layout title="index" back={false}>
        x
      </Layout>,
    );
    expect(html).not.toContain('href="/"');
  });

  test("renders its children", async () => {
    const html = await render(
      <Layout title="weight">
        <p>the body of the page</p>
      </Layout>,
    );
    expect(html).toContain("the body of the page");
  });
});
