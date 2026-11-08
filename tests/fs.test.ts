import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readTextFile, writeTextFile } from "../src/fs.js";
import { rejectionMessage } from "./helpers/assert.js";

const originalFetch = globalThis.fetch;
let urlCounter = 0;
// The module caches by URL, so every test needs its own.
const uniqueUrl = (): string => {
  urlCounter += 1;
  return `https://example.test/file-${urlCounter}.txt`;
};

const stubFetch = (...responses: readonly (Response | Error)[]) => {
  let call = 0;
  const fetchMock = mock(() => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve((next as Response).clone());
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

describe("readTextFile from a URL", () => {
  beforeEach(() => {
    // Run backoff delays immediately.
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callback();
      return 0;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    mock.restore();
    globalThis.fetch = originalFetch;
  });

  test("returns the response text", async () => {
    stubFetch(new Response("hello"));
    expect(await readTextFile(uniqueUrl())).toBe("hello");
  });

  test("shares one request between concurrent and later reads", async () => {
    const fetchMock = stubFetch(new Response("once"));
    const url = uniqueUrl();
    const results = await Promise.all([readTextFile(url), readTextFile(url)]);
    expect(results).toEqual(["once", "once"]);
    expect(await readTextFile(url)).toBe("once");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not retry a 404", async () => {
    const fetchMock = stubFetch(new Response("", { status: 404, statusText: "Not Found" }));
    expect(await rejectionMessage(readTextFile(uniqueUrl()))).toContain("404 Not Found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([429, 500, 503])("retries a %d response", async (status) => {
    const fetchMock = stubFetch(new Response("", { status }), new Response("recovered"));
    expect(await readTextFile(uniqueUrl())).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries a network error", async () => {
    const fetchMock = stubFetch(new Error("socket hang up"), new Response("recovered"));
    expect(await readTextFile(uniqueUrl())).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("gives up after four attempts", async () => {
    const fetchMock = stubFetch(new Error("socket hang up"));
    expect(await rejectionMessage(readTextFile(uniqueUrl()))).toContain("after 4 attempts: socket hang up");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("does not cache a failure", async () => {
    const url = uniqueUrl();
    stubFetch(new Response("", { status: 404 }));
    expect(await rejectionMessage(readTextFile(url))).toContain("404");
    stubFetch(new Response("now present"));
    expect(await readTextFile(url)).toBe("now present");
  });
});

describe("local files", () => {
  test("writeTextFile creates parent directories and readTextFile reads the result", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fs-test-"));
    try {
      const filePath = path.join(dir, "a/b/c.txt");
      await writeTextFile(filePath, "contents");
      expect(await readFile(filePath, "utf8")).toBe("contents");
      expect(await readTextFile(filePath)).toBe("contents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
