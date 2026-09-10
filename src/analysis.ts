import { MemoryDiagnosticCollector } from "./diagnostics.js";
import { ParameterCollector } from "./analysis/collector.js";
import { createDebugLogger } from "./analysis/debug.js";
import { analyzeFunction } from "./analysis/traversal.js";
import type {
  AliasTarget,
  DebugConfig,
  ExtractionContext,
  FunctionDefinition,
  RouteExtraction,
  RouteRegistration,
} from "./types.js";

export function extractRouteData(
  route: RouteRegistration,
  functions: ReadonlyMap<string, FunctionDefinition>,
  constants: ReadonlyMap<string, string>,
  maxCallDepth: number,
  debugConfig: DebugConfig,
): RouteExtraction {
  const diagnostics = new MemoryDiagnosticCollector();
  const definition = functions.get(route.handler);
  const routeKey = `${route.method} ${route.pathTemplate}`;
  const debug = createDebugLogger(routeKey, debugConfig);
  const collector = new ParameterCollector(route);
  const initialPathParams = collector.snapshot("path");
  let pathParams = initialPathParams;

  if (definition === undefined) {
    diagnostics.add({
      level: "error",
      code: "handler_not_found",
      message: `Could not find function body for handler ${route.handler}.`,
      routeKey,
      source: route.source,
    });
    return {
      route,
      pathParams: initialPathParams,
      queryParams: [],
      bodyParams: [],
      diagnostics: diagnostics.snapshot(),
    };
  }

  const context: ExtractionContext = {
    aliasTargets: new Map<string, AliasTarget>(),
    constants,
    functions,
    diagnostics,
    maxCallDepth,
    pathParamNames: new Set(initialPathParams.map((parameter) => parameter.canonicalPath)),
  };

  const visited = new Set<string>();
  analyzeFunction(definition, context, collector, visited, 0, routeKey, debug);
  pathParams = collector.snapshot("path");
  debug(
    `path params => ${
      pathParams.map((item) => item.canonicalPath).join(", ") || "(none)"
    }`,
  );
  const queryParams = collector.snapshot("query");
  const bodyParams = collector.snapshot("body");
  debug(
    `query params => ${
      queryParams.map((item) => item.canonicalPath).join(", ") || "(none)"
    }`,
  );
  debug(
    `body params => ${bodyParams.map((item) => item.canonicalPath).join(", ") || "(none)"}`,
  );

  return {
    route,
    pathParams,
    queryParams,
    bodyParams,
    diagnostics: diagnostics.snapshot(),
  };
}
