import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExtraction } from "../src/index.js";
import type { ApiRouteSpec, ApiSpec } from "../src/types.js";
import { expectToIncludeAll } from "./helpers/assert.js";
import { stubGithub } from "./helpers/fake-github.js";
import { cloneRepo, hasClone, repoRoot } from "./helpers/local-clone.js";

// These run the whole pipeline on real Typesense source, with GitHub answered
// from the gitignored clones in tmp/. They skip when the clones are absent:
//   git clone https://github.com/typesense/typesense tmp/typesense            (v31)
//   git clone -b v30 https://github.com/typesense/typesense tmp/typesense-v30
const TIMEOUT_MS = 120_000;

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

const extractFromClone = async (clone: string, branch: string): Promise<{ spec: ApiSpec; text: string }> => {
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

  restoreGithub = stubGithub(cloneRepo(clone));
  const spec = await runExtraction({
    command: "extract",
    configPath,
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

describe.skipIf(!hasClone("typesense-v30"))("v30 clone", () => {
  test(
    "reproduces the committed output byte for byte",
    async () => {
      const { spec, text } = await extractFromClone("typesense-v30", "v30");
      expect(spec.diagnostics).toEqual([]);
      // If this fails after the nightly workflow updated output/, the clone is
      // probably stale: git -C tmp/typesense-v30 fetch && git -C tmp/typesense-v30 reset --hard origin/v30
      const committed = await readFile(path.join(repoRoot, "output/typesense_api_spec.json"), "utf8");
      expect(text === committed).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "keeps the corrections made during PR review",
    async () => {
      const { spec } = await extractFromClone("typesense-v30", "v30");

      const multiSearch = paths(findRoute(spec, "POST", "/multi_search").bodyParams);
      expectToIncludeAll(multiSearch, ["searches", "union", "remove_duplicates"]);

      for (const documentRoute of ["/collections/:collection/documents/:id", "/collections/:collection/documents/export"]) {
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
      expect(search.find((parameter) => parameter.canonicalPath === "query_by")?.valueType).toBe("string[]");

      expectToIncludeAll(multiSearch, ["searches[].q", "searches[].query_by"]);
      expectToIncludeAll(paths(findRoute(spec, "POST", "/conversations/models").bodyParams), ["model_name", "system_prompt"]);
      expectToIncludeAll(paths(findRoute(spec, "PUT", "/conversations/models/:id").bodyParams), ["model_name", "system_prompt"]);
      expectToIncludeAll(paths(findRoute(spec, "POST", "/analytics/events").bodyParams), ["name", "data", "data.user_id", "data.doc_id", "data.q"]);
      expectToIncludeAll(paths(findRoute(spec, "PUT", "/synonym_sets/:name").bodyParams), ["items", "items[].synonyms"]);
      expectToIncludeAll(paths(findRoute(spec, "PATCH", "/collections/:collection").bodyParams), ["metadata", "fields", "fields[].name"]);
      expect(paths(findRoute(spec, "PUT", "/synonym_sets/:name").queryParams)).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!hasClone("typesense"))("v31 clone", () => {
  test(
    "extracts without diagnostics and finds v31-only routes",
    async () => {
      const { spec } = await extractFromClone("typesense", "v31");
      expect(spec.diagnostics).toEqual([]);
      expect(spec.routes.length).toBeGreaterThanOrEqual(96);
      expect(findRoute(spec, "PATCH", "/keys/:id").handler.length).toBeGreaterThan(0);

      const keys = paths(findRoute(spec, "POST", "/keys").bodyParams);
      expectToIncludeAll(keys, ["joins", "joins.*.allowed_fields", "joins.*.denied_fields"]);
      expect(keys).not.toContain("joins[]");

      const search = paths(findRoute(spec, "GET", "/collections/:collection/documents/search").queryParams);
      expectToIncludeAll(search, ["q", "query_by", "filter_by", "include_fields", "per_page"]);
      expect(search).not.toContain("name");
    },
    TIMEOUT_MS,
  );
});
