// Real Response.clone().text() failure, isolated from Vitest's rejection handler.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";

/** @import { Provider } from "@earendil-works/pi-ai" */
/**
 * The part of a provider the dispatch consumes: it passes its own fetch in the
 * options and iterates the events `stream` returns.
 * @typedef {object} StreamSeam
 * @property {(
 *   model: unknown,
 *   context: unknown,
 *   options: { fetch: (url: string) => Promise<Response> },
 * ) => AsyncIterable<{ type: string }>} stream
 */

registerHooks({
  load(url, context, next) {
    if (!url.endsWith(".ts")) return next(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    };
  },
});
const { dispatchSidecarSearch, SidecarSearchError } = await import(
  "../../src/openai/sidecar-search.ts"
);
const { codexModel } = await import("../fixtures.ts");
const scenario = process.argv[2];
assert.ok(
  [
    "delayed-done",
    "delayed-throw",
    "iterator-first",
    "aborted",
    "timeout",
  ].includes(scenario),
);
const caller = new AbortController();
const timeout = new AbortController();
const originalTimeout = AbortSignal.timeout;
AbortSignal.timeout = () => timeout.signal;
/** @type {ReadableStreamDefaultController<Uint8Array>} */
let controller;
let bodyFailed = false;
let fetches = 0;
let settlements = 0;
let originalRead;
const failBody = () => {
  if (bodyFailed) return;
  bodyFailed = true;
  controller.error(new Error("PRIVATE_BODY_ERROR"));
};
const response = new Response(
  new ReadableStream({
    start(value) {
      controller = value;
    },
  }),
  { headers: { "content-type": "text/event-stream" } },
);
/** @type {StreamSeam} */
const provider = {
  stream(_model, _context, options) {
    return {
      async *[Symbol.asyncIterator]() {
        const original = await options.fetch(
          "https://chatgpt.com/backend-api/codex/responses",
        );
        // Start consuming the original concurrently; observe only OUR read task.
        originalRead = original.text().then(
          () => false,
          () => true,
        );
        if (scenario === "iterator-first")
          throw new Error("PRIVATE_ITERATOR_ERROR");
        if (scenario === "aborted") caller.abort();
        if (scenario === "timeout") timeout.abort();
        failBody();
        assert.equal(await originalRead, true);
        // Give the unobserved Toolkit clone multiple event-loop turns to reject.
        await delay(50);
        if (scenario === "delayed-throw")
          throw new Error("PRIVATE_ITERATOR_ERROR");
        yield { type: "done" };
      },
    };
  },
};
/** @type {unknown[]} */
const debug = [];
try {
  const outcome = await dispatchSidecarSearch(
    {
      query: "PRIVATE_QUERY",
      config: { mode: "live", contextSize: "medium" },
      route: {
        model: codexModel(),
        route: {
          kind: "codex-oauth",
          endpoint: new URL("https://chatgpt.com/backend-api/codex/responses"),
        },
        token: "PRIVATE_TOKEN",
        headers: {},
      },
      thinkingLevel: "auto",
      provider: /** @type {Pick<Provider, "stream">} */ (
        /** @type {unknown} */ (provider)
      ),
      signal: caller.signal,
      debug: true,
    },
    async () => {
      fetches++;
      return response;
    },
    (line) => debug.push(JSON.parse(line)),
  ).then(
    () => {
      settlements++;
      return undefined;
    },
    (error) => {
      settlements++;
      return error;
    },
  );
  // The iterator-first case must return without waiting on the still-open clone.
  if (scenario === "iterator-first") {
    assert.equal(bodyFailed, false);
    failBody();
  }
  assert.equal(await originalRead, true);
  await delay(50);
  const category =
    scenario === "aborted" || scenario === "timeout"
      ? scenario
      : "network-error";
  assert.ok(outcome instanceof SidecarSearchError);
  assert.equal(outcome.category, category);
  assert.equal(fetches, 1);
  assert.equal(settlements, 1);
  assert.equal(debug.length, 1);
  assert.equal(
    /** @type {{ errorCategory?: unknown }} */ (debug[0]).errorCategory,
    category,
  );
  assert.ok(!JSON.stringify(debug).includes("PRIVATE_"));
  console.log(
    JSON.stringify({ scenario, category, fetches, settlements, bodyFailed }),
  );
} finally {
  failBody();
  await originalRead;
  AbortSignal.timeout = originalTimeout;
}
