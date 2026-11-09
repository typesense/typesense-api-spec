import { describe, expect, test } from "bun:test";
import { buildSpec } from "../src/spec.js";
import { mergeValueTypes } from "../src/types.js";
import type {
  ApiDiagnostic,
  CollectedParameter,
  ExtractorConfig,
  ParameterLocation,
  RouteExtraction,
  ValueType,
} from "../src/types.js";

const baseConfig: ExtractorConfig = {
  rootDir: "",
  routeFile: "server.cpp",
  sourceBranch: "v30",
  outputPath: "out.json",
  diagnosticsOutputPath: undefined,
  baseUrl: undefined,
  maxCallDepth: 4,
  failOnDiagnostics: false,
  failOnUnresolved: false,
  blacklist: { paths: [], params: [] },
  includeHelpers: [],
  overrides: [],
  debug: { enabled: false, routeFilter: undefined },
};

const param = (
  location: ParameterLocation,
  canonicalPath: string,
  valueType?: ValueType,
  line = 1,
): CollectedParameter => ({
  location,
  canonicalPath,
  valueType,
  source: { filePath: "a.cpp", line, column: 1 },
});

const extraction = (
  pathTemplate: string,
  params: { query?: readonly CollectedParameter[]; body?: readonly CollectedParameter[] } = {},
  method: RouteExtraction["route"]["method"] = "GET",
): RouteExtraction => ({
  route: { method, pathTemplate, handler: "h", source: { filePath: "s.cpp", line: 1, column: 1 } },
  pathParams: [],
  queryParams: params.query ?? [],
  bodyParams: params.body ?? [],
  diagnostics: [],
});

const names = (parameters: readonly { readonly canonicalPath: string }[] | undefined) =>
  parameters?.map((parameter) => parameter.canonicalPath);

describe("buildSpec", () => {
  test("sorts routes by path, then method", () => {
    const spec = buildSpec(
      baseConfig,
      [extraction("/b"), extraction("/a", {}, "POST"), extraction("/a", {}, "GET")],
      [],
    );
    expect(spec.routes.map((route) => `${route.method} ${route.pathTemplate}`)).toEqual([
      "GET /a",
      "POST /a",
      "GET /b",
    ]);
  });

  test("gives untyped params a default type for their location", () => {
    const [route] = buildSpec(
      baseConfig,
      [extraction("/a", { query: [param("query", "q")], body: [param("body", "b")] })],
      [],
    ).routes;
    expect(route?.queryParams[0]?.valueType).toBe("string");
    expect(route?.bodyParams[0]?.valueType).toBe("unknown");
  });

  test("merges duplicate params and sorts their sources", () => {
    const [route] = buildSpec(
      baseConfig,
      [extraction("/a", { body: [param("body", "x", "string", 9), param("body", "x", "integer", 2)] })],
      [],
    ).routes;
    expect(route?.bodyParams).toHaveLength(1);
    expect(String(route?.bodyParams[0]?.valueType)).toBe("integer | string");
    expect(route?.bodyParams[0]?.sources.map((source) => source.line)).toEqual([2, 9]);
  });

  test("drops malformed canonical paths", () => {
    const [route] = buildSpec(
      baseConfig,
      [
        extraction("/a", {
          body: [param("body", ""), param("body", "a."), param("body", "a..b"), param("body", "ok")],
        }),
      ],
      [],
    ).routes;
    expect(names(route?.bodyParams)).toEqual(["ok"]);
  });

  test("applies path and param blacklists", () => {
    const spec = buildSpec(
      { ...baseConfig, blacklist: { paths: ["/hidden"], params: ["secret"] } },
      [
        extraction("/hidden"),
        extraction("/a", { body: [param("body", "secret"), param("body", "nested.secret"), param("body", "ok")] }),
      ],
      [],
    );
    expect(spec.routes.map((route) => route.pathTemplate)).toEqual(["/a"]);
    expect(names(spec.routes[0]?.bodyParams)).toEqual(["ok"]);
  });

  test("a blacklisted path covers its subpaths, not paths that only share a prefix", () => {
    const spec = buildSpec(
      { ...baseConfig, blacklist: { paths: ["/limits"], params: [] } },
      [extraction("/limits"), extraction("/limits/:id"), extraction("/limits/active/:id"), extraction("/limits_other")],
      [],
    );
    expect(spec.routes.map((route) => route.pathTemplate)).toEqual(["/limits_other"]);
  });

  test("records the source branch and commit", () => {
    const spec = buildSpec({ ...baseConfig, sourceBranch: "v31" }, [], [], "abc123");
    expect(spec.sourceBranch).toBe("v31");
    expect(spec.sourceCommit).toBe("abc123");
  });

  test("override skip removes a route, optionally for one method only", () => {
    const spec = buildSpec(
      { ...baseConfig, overrides: [{ path: "/a", method: "POST", skip: true }] },
      [extraction("/a", {}, "GET"), extraction("/a", {}, "POST")],
      [],
    );
    expect(spec.routes.map((route) => route.method)).toEqual(["GET"]);
  });

  test("override adds and removes params", () => {
    const [route] = buildSpec(
      {
        ...baseConfig,
        overrides: [
          {
            path: "/a",
            removeParams: ["old"],
            addParams: [
              { location: "query", name: "added" },
              { location: "body", name: "ignored_name", canonicalPath: "deep.added" },
            ],
          },
        ],
      },
      [extraction("/a", { query: [param("query", "old"), param("query", "kept")] })],
      [],
    ).routes;
    expect(names(route?.queryParams)).toEqual(["added", "kept"]);
    expect(names(route?.bodyParams)).toEqual(["deep.added"]);
  });

  test("builds the URL template without a doubled slash", () => {
    const [route] = buildSpec({ ...baseConfig, baseUrl: "http://host:8108/" }, [extraction("/a")], []).routes;
    expect(route?.urlTemplate).toBe("http://host:8108/a");
  });

  test("keeps only the diagnostics that belong to a route", () => {
    const diagnostic = (routeKey: string): ApiDiagnostic => ({
      level: "warning",
      code: "c",
      message: "m",
      routeKey,
      source: undefined,
    });
    const base = extraction("/a");
    const [route] = buildSpec(
      baseConfig,
      [{ ...base, diagnostics: [diagnostic("GET /a"), diagnostic("GET /other")] }],
      [],
    ).routes;
    expect(route?.diagnostics.map((item) => item.routeKey)).toEqual(["GET /a"]);
  });

  test("drops the diagnostics of blacklisted and skipped routes", () => {
    const diagnostic = (routeKey: string | undefined): ApiDiagnostic => ({
      level: "warning",
      code: "c",
      message: "m",
      routeKey,
      source: undefined,
    });
    const diagnostics = ["GET /a", "GET /limits/:id", "POST /skipped", undefined].map(diagnostic);
    const spec = buildSpec(
      {
        ...baseConfig,
        blacklist: { paths: ["/limits"], params: [] },
        overrides: [{ path: "/skipped", method: "POST", skip: true }],
      },
      [extraction("/a"), extraction("/limits/:id"), extraction("/skipped", {}, "POST")],
      diagnostics,
    );
    expect(spec.diagnostics.map((item) => item.routeKey)).toEqual(["GET /a", undefined]);
  });
});

describe("mergeValueTypes", () => {
  test("returns the known side when the other is undefined", () => {
    expect(mergeValueTypes(undefined, "string")).toBe("string");
    expect(mergeValueTypes("string", undefined)).toBe("string");
    expect(mergeValueTypes(undefined, undefined)).toBeUndefined();
  });

  test("prefers a specific array type over plain array", () => {
    expect(mergeValueTypes("array", "string[]")).toBe("string[]");
    expect(mergeValueTypes("string[]", "array")).toBe("string[]");
  });

  test("builds a sorted union that does not depend on argument order", () => {
    expect(String(mergeValueTypes("string", "integer"))).toBe("integer | string");
    expect(String(mergeValueTypes("integer", "string"))).toBe("integer | string");
    const union = mergeValueTypes("integer", "string");
    expect(String(mergeValueTypes(union, "boolean"))).toBe("boolean | integer | string");
  });

  test("keeps the narrowest numeric type", () => {
    expect(mergeValueTypes("integer", "uint")).toBe("uint");
    expect(mergeValueTypes("number", "integer")).toBe("integer");
    expect(String(mergeValueTypes("number", mergeValueTypes("string", "uint")))).toBe("string | uint");
  });
});
