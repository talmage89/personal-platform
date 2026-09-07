import { afterEach, describe, expect, test } from "bun:test";
import type { AgentConfig } from "./config.ts";
import { chat, OpenRouterError, type ToolSpec } from "./openrouter.ts";

/**
 * The loop is the part of this package that can spend money without anyone
 * watching, so its bounds are pinned here rather than trusted. Every case below
 * asserts the same two things: that it stopped, and that it still produced
 * prose when it did.
 */

const config = {
  OPENROUTER_API_KEY: "test",
  AGENT_SELF_MARKER: "marker",
} as AgentConfig;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replies in order; the last reply repeats if the loop asks again. */
function mockReplies(replies: unknown[]): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return { bodies };
}

const says = (content: string) => ({ choices: [{ message: { content } }], usage: { cost: 0.01 } });

const callsTool = (name: string, args = "{}", id = "call_1") => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
      },
    },
  ],
  usage: { cost: 0.01 },
});

const counter = (): ToolSpec & { runs: number } => {
  const tool = {
    runs: 0,
    name: "probe",
    description: "test tool",
    parameters: { type: "object", properties: {} },
    run: async () => {
      tool.runs += 1;
      return "ok";
    },
  };
  return tool;
};

describe("the tool loop", () => {
  test("returns text and calls nothing when the model just answers", async () => {
    mockReplies([says("a quiet hour")]);
    const result = await chat(config, {
      model: "m",
      system: "s",
      user: "u",
      maxTokens: 100,
      tools: [counter()],
      maxToolCalls: 4,
    });

    expect(result.text).toBe("a quiet hour");
    expect(result.toolCalls).toEqual([]);
    expect(result.stoppedEarly).toBeNull();
  });

  test("runs a requested tool and feeds the result back", async () => {
    const tool = counter();
    const { bodies } = mockReplies([callsTool("probe"), says("done")]);

    const result = await chat(config, {
      model: "m",
      system: "s",
      user: "u",
      maxTokens: 100,
      tools: [tool],
      maxToolCalls: 4,
    });

    expect(tool.runs).toBe(1);
    expect(result.text).toBe("done");
    expect(result.toolCalls).toEqual([{ name: "probe", args: "{}", ok: true }]);

    // The tool's output has to reach the model, or it answered without it.
    const second = bodies[1]?.messages as { role: string; content: string }[];
    expect(second.at(-1)).toMatchObject({ role: "tool", content: "ok" });
  });

  test("a throwing tool is reported to the model, not to the caller", async () => {
    const tool: ToolSpec = {
      name: "probe",
      description: "",
      parameters: {},
      run: async () => {
        throw new Error("nope");
      },
    };
    const { bodies } = mockReplies([callsTool("probe"), says("carried on")]);

    const result = await chat(config, {
      model: "m",
      system: "s",
      user: "u",
      maxTokens: 100,
      tools: [tool],
      maxToolCalls: 4,
    });

    expect(result.text).toBe("carried on");
    expect(result.toolCalls[0]?.ok).toBe(false);
    const second = bodies[1]?.messages as { role: string; content: string }[];
    expect(second.at(-1)?.content).toContain("nope");
  });

  test("stops at the tool budget and still writes a summary", async () => {
    const tool = counter();

    // Asks for the tool whenever tools are offered, and only writes prose once
    // they are withheld — the shape that would loop forever without a budget.
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
      const reply = body.tools ? callsTool("probe") : says("wrote it up anyway");
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as typeof fetch;

    const result = await chat(config, {
      model: "m",
      system: "s",
      user: "u",
      maxTokens: 100,
      tools: [tool],
      maxToolCalls: 2,
    });

    expect(tool.runs).toBe(2);
    expect(result.stoppedEarly).toBe("reached the tool-call budget");
    expect(result.text).toBe("wrote it up anyway");
  });

  test("a passed deadline withholds tools and asks once for the write-up", async () => {
    const tool = counter();
    const { bodies } = mockReplies([says("out of time, here is what I have")]);

    const result = await chat(config, {
      model: "m",
      system: "s",
      user: "u",
      maxTokens: 100,
      tools: [tool],
      maxToolCalls: 8,
      deadline: new Date(Date.now() - 1_000),
    });

    expect(tool.runs).toBe(0);
    expect(result.stoppedEarly).toBe("ran out of time");
    expect(result.text).toBe("out of time, here is what I have");
    expect(bodies[0]?.tools).toBeUndefined();
  });

  test("tools are never offered when the budget is zero", async () => {
    const { bodies } = mockReplies([says("brief")]);
    await chat(config, {
      model: "m",
      system: "s",
      user: "u",
      maxTokens: 100,
      tools: [counter()],
      maxToolCalls: 0,
    });
    expect(bodies[0]?.tools).toBeUndefined();
  });

  test("an aborted request becomes an OpenRouterError, not a raw DOMException", async () => {
    // The degradation path in narrate.ts keys on OpenRouterError. An AbortError
    // escaping as itself took the whole run down and lost the arithmetic with
    // it, which is exactly what that path exists to prevent.
    globalThis.fetch = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as typeof fetch;

    let caught: unknown;
    try {
      await chat(config, { model: "m", system: "s", user: "u", maxTokens: 100 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenRouterError);
    expect((caught as OpenRouterError).message).toContain("timed out");
  });

  test("every request is tagged so the reader can exclude it", async () => {
    const { bodies } = mockReplies([says("x")]);
    await chat(config, { model: "m", system: "s", user: "u", maxTokens: 100 });
    expect(bodies[0]?.user).toBe("marker");
  });
});
