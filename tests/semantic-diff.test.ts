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

const toParams = (values: Readonly<Record<string, string>> = {}) =>
  Object.entries(values).map(([canonicalPath, valueType]) => ({ canonicalPath, valueType }));

let fileCounter = 0;
const writeSpec = async (routes: readonly RouteInput[]): Promise<string> => {
  fileCounter += 1;
  const filePath = path.join(await dirPromise, `spec-${fileCounter}.json`);
  await writeFile(
    filePath,
    JSON.stringify({
      routes: routes.map((route) => ({
        method: route.method ?? "GET",
        pathTemplate: route.path,
        pathParams: [],
        queryParams: toParams(route.query),
        bodyParams: toParams(route.body),
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
    expect(await diff(routes, routes)).toEqual({ changed: false, addedRoutes: [], removedRoutes: [], changedRoutes: [] });
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
    expect(markdown).toContain("## Added routes\n\n- GET /new");
    expect(markdown).toContain("## Removed routes\n\n- GET /gone");
    expect(markdown).toContain("### GET /a");
    expect(markdown).toContain("- Added parameter: body:fresh");
    expect(markdown).toContain("- Removed parameter: body:old");
    expect(markdown).toContain("- Changed parameter type: body:x (string -> integer)");
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
