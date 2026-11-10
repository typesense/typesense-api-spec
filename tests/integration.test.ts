import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExtraction } from "../src/index.js";
import type { ApiRouteSpec, ApiSpec } from "../src/types.js";
import { expectToIncludeAll } from "./helpers/assert.js";
import { stubGithub } from "./helpers/fake-github.js";
import { clonePath, cloneRepo, hasClone, hasCommit, repoRoot } from "./helpers/local-clone.js";

// These run the whole pipeline on real Typesense source, with GitHub answered
// from the gitignored clone in tmp/. They skip when it is absent:
//   git clone https://github.com/typesense/typesense tmp/typesense
const TIMEOUT_MS = 120_000;
const CLONE = "typesense";
/** The v30 tests read the clone at this tag, wherever its HEAD is. */
const V30 = "v30.2";

const dirPromise = mkdtemp(path.join(tmpdir(), "integration-test-"));
afterAll(async () => rm(await dirPromise, { recursive: true, force: true }));

let restoreGithub = (): void => undefined;
beforeEach(() => {
  spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  mock.restore();
  restoreGithub();
});

const extractFromClone = async (
  clone: string,
  branch: string,
  ref?: string,
): Promise<{ spec: ApiSpec; text: string }> => {
  const dir = path.join(await dirPromise, branch);
  const repoConfig = JSON.parse(await readFile(path.join(repoRoot, "config.json"), "utf8")) as object;
  const configPath = path.join(await dirPromise, `${branch}.json`);
  const outputPath = path.join(dir, "spec.json");
  await writeFile(
    configPath,
    JSON.stringify({
      ...repoConfig,
      source_branch: branch,
      output_path: outputPath,
      diagnostics_output_path: path.join(dir, "diagnostics.json"),
    }),
  );

  restoreGithub = stubGithub(cloneRepo(clone, ref));
  const spec = await runExtraction({
    command: "extract",
    configPath,
    sourceBranch: undefined,
    outputPath: undefined,
    baseUrl: undefined,
    maxCallDepth: undefined,
    failOnDiagnostics: undefined,
    failOnUnresolved: undefined,
    verbose: false,
    debugRoute: undefined,
    json: true,
  });
  return { spec, text: await readFile(outputPath, "utf8") };
};

const findRoute = (spec: ApiSpec, method: string, pathTemplate: string): ApiRouteSpec => {
  const route = spec.routes.find((item) => item.method === method && item.pathTemplate === pathTemplate);
  if (route === undefined) {
    throw new Error(`Route not found: ${method} ${pathTemplate}`);
  }
  return route;
};

const paths = (parameters: ApiRouteSpec["bodyParams"]): readonly string[] =>
  parameters.map((parameter) => parameter.canonicalPath);

// output/ records the Typesense commit it came from, so the clone can reproduce it
// wherever its own HEAD is. Fetch the clone if this skips.
const committedText = readFileSync(path.join(repoRoot, "output/typesense_api_spec.json"), "utf8");
const committed = JSON.parse(committedText) as ApiSpec;
const committedCommit = committed.sourceCommit ?? "";

describe.skipIf(!hasCommit(CLONE, committedCommit))("committed output", () => {
  test(
    "is reproduced byte for byte from the commit it records",
    async () => {
      const { spec, text } = await extractFromClone(CLONE, committed.sourceBranch ?? "", committedCommit);
      expect(spec.diagnostics).toEqual([]);
      // If the extractor's output changed, regenerate output/ from the release it records:
      //   bun src/cli.ts extract --source-branch "$(jq -r .sourceBranch output/typesense_api_spec.json)"
      expect(text === committedText).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!hasCommit(CLONE, V30))("v30", () => {
  test(
    "cites where a parameter is read or named, not where it is masked or looked up",
    async () => {
      const { spec } = await extractFromClone(CLONE, "v30", V30);
      const citation = (
        method: string,
        routePath: string,
        location: "queryParams" | "bodyParams",
        name: string,
      ): string => {
        const parameter = findRoute(spec, method, routePath)[location].find(
          (candidate) => candidate.canonicalPath === name,
        );
        return parameter?.sources[0]?.filePath ?? "";
      };

      expect(citation("POST", "/nl_search_models", "bodyParams", "api_key")).toEndWith(
        "/natural_language_search_model.cpp",
      );
      expect(citation("POST", "/conversations/models", "bodyParams", "api_key")).toEndWith("/conversation_model.cpp");

      const route = findRoute(spec, "GET", "/collections/:collection/documents/search");
      const perPage = route.queryParams.find((candidate) => candidate.canonicalPath === "limit_hits")?.sources[0];
      const source = await Bun.$`git -C ${clonePath(CLONE)} show ${`${V30}:src/collection.cpp`}`.text();
      expect(source.split("\n")[(perPage?.line ?? 1) - 1]).toContain("LIMIT_HITS");
    },
    TIMEOUT_MS,
  );

  test(
    "keeps the corrections made during PR review",
    async () => {
      const { spec } = await extractFromClone(CLONE, "v30", V30);

      const multiSearch = paths(findRoute(spec, "POST", "/multi_search").bodyParams);
      expectToIncludeAll(multiSearch, ["searches", "union", "remove_duplicates"]);

      for (const documentRoute of [
        "/collections/:collection/documents/:id",
        "/collections/:collection/documents/export",
      ]) {
        const query = paths(findRoute(spec, "GET", documentRoute).queryParams);
        expectToIncludeAll(query, ["include_fields", "exclude_fields"]);
      }

      const collection = findRoute(spec, "POST", "/collections").bodyParams;
      expectToIncludeAll(paths(collection), [
        "fields[].locale",
        "fields[].embed.model_config.indexing_prefix",
        "fields[].embed.model_config.query_prefix",
      ]);
      expect(paths(collection)).not.toContain("fields[]");

      const search = findRoute(spec, "GET", "/collections/:collection/documents/search").queryParams;
      expectToIncludeAll(paths(search), ["q", "query_by", "filter_by", "sort_by", "facet_by", "per_page", "page"]);
      expect(paths(search)).not.toContain("collection");
      expect(paths(search)).not.toContain("name");
      expect(search.find((parameter) => parameter.canonicalPath === "per_page")?.valueType).toBe("uint");
      expect(search.find((parameter) => parameter.canonicalPath === "query_by")?.valueType).toBe("string");

      expectToIncludeAll(multiSearch, ["searches[].q", "searches[].query_by"]);
      expectToIncludeAll(paths(findRoute(spec, "POST", "/conversations/models").bodyParams), [
        "model_name",
        "system_prompt",
      ]);
      expectToIncludeAll(paths(findRoute(spec, "PUT", "/conversations/models/:id").bodyParams), [
        "model_name",
        "system_prompt",
      ]);
      expectToIncludeAll(paths(findRoute(spec, "POST", "/analytics/events").bodyParams), [
        "name",
        "data",
        "data.user_id",
        "data.doc_id",
        "data.q",
      ]);
      expectToIncludeAll(paths(findRoute(spec, "PUT", "/synonym_sets/:name").bodyParams), [
        "items",
        "items[].synonyms",
      ]);
      expectToIncludeAll(paths(findRoute(spec, "PATCH", "/collections/:collection").bodyParams), [
        "metadata",
        "fields",
        "fields[].name",
      ]);
      expect(paths(findRoute(spec, "PUT", "/synonym_sets/:name").queryParams)).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

// Whatever the clone has checked out, so pulling it is an early check that the
// extractor still handles newer code. Assertions here must hold for any version.
describe.skipIf(!hasClone(CLONE))("checked-out clone", () => {
  test(
    "extracts without diagnostics",
    async () => {
      const { spec } = await extractFromClone(CLONE, "checked-out");
      expect(spec.diagnostics).toEqual([]);
      expect(spec.routes.length).toBeGreaterThanOrEqual(80);

      const search = paths(findRoute(spec, "GET", "/collections/:collection/documents/search").queryParams);
      expectToIncludeAll(search, ["q", "query_by", "filter_by", "include_fields", "per_page"]);
      expect(search).not.toContain("name");
    },
    TIMEOUT_MS,
  );
});
