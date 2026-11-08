import { afterEach, describe, expect, test } from "bun:test";
import { listSourceFiles, resolveRawGithubUrl, resolveSourcePath } from "../src/source.js";
import { rejectionMessage } from "./helpers/assert.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const stubTree = (body: unknown, status = 200): void => {
  globalThis.fetch = (() => Promise.resolve(Response.json(body, { status }))) as unknown as typeof fetch;
};

describe("resolveSourcePath", () => {
  test("joins the root directory and normalizes separators", () => {
    expect(resolveSourcePath("", "src/a.cpp")).toBe("src/a.cpp");
    expect(resolveSourcePath("/server/", "/src/a.cpp")).toBe("server/src/a.cpp");
    expect(resolveSourcePath("server", "src\\a.cpp")).toBe("server/src/a.cpp");
  });

  test("leaves full URLs alone", () => {
    expect(resolveSourcePath("server", "https://example.test/a.cpp")).toBe("https://example.test/a.cpp");
  });

  test("rejects an empty path", () => {
    expect(() => resolveSourcePath("server", "/")).toThrow("cannot be empty");
  });
});

describe("resolveRawGithubUrl", () => {
  test("builds a raw.githubusercontent.com URL for the branch", () => {
    expect(resolveRawGithubUrl("v30", "/src/a.cpp")).toBe(
      "https://raw.githubusercontent.com/typesense/typesense/v30/src/a.cpp",
    );
  });

  test("rejects an empty path", () => {
    expect(() => resolveRawGithubUrl("v30", "")).toThrow("cannot be empty");
  });
});

describe("listSourceFiles", () => {
  test("keeps blobs with a matching extension inside the root directory", async () => {
    stubTree({
      truncated: false,
      tree: [
        { path: "server/a.cpp", type: "blob" },
        { path: "server/b.h", type: "blob" },
        { path: "server/c.md", type: "blob" },
        { path: "server/dir.cpp", type: "tree" },
        { path: "server-other/d.cpp", type: "blob" },
        { path: "e.cpp", type: "blob" },
      ],
    });
    expect(await listSourceFiles("filter-branch", "server", [".cpp", ".h"])).toEqual(["server/a.cpp", "server/b.h"]);
  });

  test("asks GitHub for a branch's tree only once", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(Response.json({ truncated: false, tree: [{ path: "a.cpp", type: "blob" }] }));
    }) as unknown as typeof fetch;
    await listSourceFiles("once-branch", "", [".cpp"]);
    await listSourceFiles("once-branch", "", [".h"]);
    expect(calls).toBe(1);
  });

  test("retries a failed listing on the next call", async () => {
    stubTree({ message: "Not Found" }, 404);
    await rejectionMessage(listSourceFiles("retry-branch", "", [".cpp"]));
    stubTree({ truncated: false, tree: [{ path: "a.cpp", type: "blob" }] });
    expect(await listSourceFiles("retry-branch", "", [".cpp"])).toEqual(["a.cpp"]);
  });

  test("refuses a truncated tree rather than returning partial results", async () => {
    stubTree({ truncated: true, tree: [] });
    expect(await rejectionMessage(listSourceFiles("truncated-branch", "", [".cpp"]))).toContain("truncated");
  });

  test("names the repo and branch when the listing fails", async () => {
    stubTree({ message: "Not Found" }, 404);
    expect(await rejectionMessage(listSourceFiles("no-such-branch", "", [".cpp"]))).toContain(
      "Could not list typesense/typesense@no-such-branch",
    );
  });

  test("suggests GITHUB_TOKEN only when it is unset", async () => {
    const saved = process.env.GITHUB_TOKEN;
    try {
      stubTree({ message: "Not Found" }, 404);
      delete process.env.GITHUB_TOKEN;
      expect(await rejectionMessage(listSourceFiles("x", "", [".cpp"]))).toContain("Set GITHUB_TOKEN");
      process.env.GITHUB_TOKEN = "token";
      expect(await rejectionMessage(listSourceFiles("x", "", [".cpp"]))).not.toContain("Set GITHUB_TOKEN");
    } finally {
      if (saved === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = saved;
      }
    }
  });
});
