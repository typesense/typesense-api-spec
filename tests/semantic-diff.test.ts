import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSemanticDiff } from "../src/semantic-diff.js";

const dirPromise = mkdtemp(path.join(tmpdir(), "semantic-diff-"));
afterAll(async () => rm(await dirPromise, { recursive: true, force: true }));

interface RouteInput {
  readonly method?: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string>>;
}

const RAW = "https://raw.githubusercontent.com/typesense/typesense/v31/src";
const BLOB = "https://github.com/typesense/typesense/blob";

const toParams = (location: string, values: Readonly<Record<string, string>> = {}) =>
  Object.entries(values).map(([canonicalPath, valueType]) => ({
    canonicalPath,
    location,
    valueType,
    sources: [{ filePath: `${RAW}/${canonicalPath}.cpp`, line: 7, column: 1 }],
  }));

let fileCounter = 0;
const writeSpec = async (routes: readonly RouteInput[], sourceCommit?: string): Promise<string> => {
  fileCounter += 1;
  const filePath = path.join(await dirPromise, `spec-${fileCounter}.json`);
  await writeFile(
    filePath,
    JSON.stringify({
      sourceBranch: "v31",
      sourceCommit,
      routes: routes.map((route) => ({
        method: route.method ?? "GET",
        pathTemplate: route.path,
        pathParams: [],
        queryParams: toParams("query", route.query),
        bodyParams: toParams("body", route.body),
        source: { filePath: `${RAW}/server.cpp`, line: 3, column: 1 },
      })),
    }),
  );
  return filePath;
};

const diff = async (previous: readonly RouteInput[], next: readonly RouteInput[]) =>
  runSemanticDiff({
    previousPath: await writeSpec(previous),
    nextPath: await writeSpec(next),
    jsonOutputPath: undefined,
    markdownOutputPath: undefined,
  });

describe("runSemanticDiff", () => {
  test("reports no change for identical specs", async () => {
    const routes = [{ path: "/a", query: { q: "string" } }];
    expect(await diff(routes, routes)).toEqual({
      changed: false,
      addedRoutes: [],
      removedRoutes: [],
      changedRoutes: [],
    });
  });

  test("ignores route order and fields outside the API shape", async () => {
    const summary = await diff([{ path: "/a" }, { path: "/b" }], [{ path: "/b" }, { path: "/a" }]);
    expect(summary.changed).toBe(false);
  });

  test("treats the same path with another method as a different route", async () => {
    const summary = await diff([{ path: "/a", method: "GET" }], [{ path: "/a", method: "POST" }]);
    expect(summary.addedRoutes).toEqual(["POST /a"]);
    expect(summary.removedRoutes).toEqual(["GET /a"]);
  });

  test("reports added and removed params, keyed by location", async () => {
    const summary = await diff(
      [{ path: "/a", query: { old: "string" } }],
      [{ path: "/a", query: { fresh: "string" }, body: { fresh: "string" } }],
    );
    expect(summary.changedRoutes).toEqual([
      {
        routeKey: "GET /a",
        addedParams: ["body:fresh", "query:fresh"],
        removedParams: ["query:old"],
        changedParamTypes: [],
      },
    ]);
  });

  test("reports param type changes", async () => {
    const summary = await diff([{ path: "/a", body: { x: "string" } }], [{ path: "/a", body: { x: "integer" } }]);
    expect(summary.changedRoutes[0]?.changedParamTypes).toEqual([
      { parameterKey: "body:x", previousType: "string", nextType: "integer" },
    ]);
  });

  test("treats every route as added when the previous spec is the workflow's empty placeholder", async () => {
    const summary = await diff([], [{ path: "/a" }]);
    expect(summary.addedRoutes).toEqual(["GET /a"]);
  });

  test("writes JSON and Markdown reports", async () => {
    const dir = await dirPromise;
    const jsonOutputPath = path.join(dir, "nested/report.json");
    const markdownOutputPath = path.join(dir, "nested/report.md");
    const summary = await runSemanticDiff({
      previousPath: await writeSpec([{ path: "/gone" }, { path: "/a", body: { x: "string", old: "string" } }]),
      nextPath: await writeSpec([{ path: "/new" }, { path: "/a", body: { x: "integer", fresh: "string" } }]),
      jsonOutputPath,
      markdownOutputPath,
    });

    expect(JSON.parse(await readFile(jsonOutputPath, "utf8"))).toEqual(JSON.parse(JSON.stringify(summary)));
    const markdown = await readFile(markdownOutputPath, "utf8");
    expect(markdown).toContain("## Added routes\n\n| Route | Source |");
    expect(markdown).toContain("| `GET /new` |");
    expect(markdown).toContain("## Removed routes\n\n| Route | Source |");
    expect(markdown).toContain("| `GET /gone` |");
    expect(markdown).toContain("### `GET /a`");
    expect(markdown).toContain("| 🟢 Added | body | `fresh` | `string` |");
    expect(markdown).toContain("| 🔴 Removed | body | `old` | `string` |");
    expect(markdown).toContain("| 🟡 Type changed | body | `x` | `string` → `integer` |");
  });

  const markdownFor = async (
    previous: readonly RouteInput[],
    previousCommit: string | undefined,
    next: readonly RouteInput[],
    nextCommit: string | undefined,
  ): Promise<string> => {
    const markdownOutputPath = path.join(await dirPromise, `links-${String(fileCounter)}.md`);
    await runSemanticDiff({
      previousPath: await writeSpec(previous, previousCommit),
      nextPath: await writeSpec(next, nextCommit),
      jsonOutputPath: undefined,
      markdownOutputPath,
    });
    return readFile(markdownOutputPath, "utf8");
  };

  test("links the Typesense commit range and each change's source at the right commit", async () => {
    const markdown = await markdownFor(
      [{ path: "/gone" }, { path: "/a", body: { old: "string" } }],
      "aaaaaaa1111",
      [{ path: "/new" }, { path: "/a", body: { fresh: "string" } }],
      "bbbbbbb2222",
    );
    expect(markdown).toContain(
      "**Typesense `v31`**: [`aaaaaaa...bbbbbbb`](https://github.com/typesense/typesense/compare/aaaaaaa1111...bbbbbbb2222)",
    );
    expect(markdown).toContain(`| \`GET /new\` | [\`src/server.cpp:3\`](${BLOB}/bbbbbbb2222/src/server.cpp#L3) |`);
    expect(markdown).toContain(`| \`GET /gone\` | [\`src/server.cpp:3\`](${BLOB}/aaaaaaa1111/src/server.cpp#L3) |`);
    expect(markdown).toContain(`[\`src/fresh.cpp:7\`](${BLOB}/bbbbbbb2222/src/fresh.cpp#L7)`);
    expect(markdown).toContain(`[\`src/old.cpp:7\`](${BLOB}/aaaaaaa1111/src/old.cpp#L7)`);
    expect(markdown).toContain(
      "**1** route changed · **1** route added · **1** route removed · **1** parameter added · **1** parameter removed",
    );
  });

  test("escapes union types so they stay in one table cell", async () => {
    const markdown = await markdownFor(
      [{ path: "/a", body: { x: "uint" } }],
      "aaaaaaa1111",
      [{ path: "/a", body: { x: "integer | uint" } }],
      "bbbbbbb2222",
    );
    expect(markdown).toContain("`uint` → `integer \\| uint`");
  });

  test("says when the changes can't have come from Typesense", async () => {
    const markdown = await markdownFor([], "aaaaaaa1111", [{ path: "/new" }], "aaaaaaa1111");
    expect(markdown).toContain("not from Typesense");
  });

  test("handles a previous spec written before commits were recorded", async () => {
    const markdown = await markdownFor([], undefined, [{ path: "/new" }], "bbbbbbb2222");
    expect(markdown).toContain("[`bbbbbbb`](https://github.com/typesense/typesense/commit/bbbbbbb2222)");
  });

  test("says when nothing needs an openapi.yml update", async () => {
    const markdownOutputPath = path.join(await dirPromise, "unchanged.md");
    await runSemanticDiff({
      previousPath: await writeSpec([{ path: "/a" }]),
      nextPath: await writeSpec([{ path: "/a" }]),
      jsonOutputPath: undefined,
      markdownOutputPath,
    });
    expect(await readFile(markdownOutputPath, "utf8")).toContain("does not include any API-shape changes");
  });
});
