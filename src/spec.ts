import type { ParameterLocation } from "./config-schema.js";
import { extractPathName, normalizePathSegments, sortedReadonly } from "./text.js";
import { isValueType } from "./types.js";
import type {
  ApiDiagnostic,
  ApiParameterSpec,
  ApiRouteSpec,
  ApiSpec,
  CollectedParameter,
  ExtractorConfig,
  HttpMethod,
  RouteExtraction,
  RouteOverride,
  SourceLocation,
  ValueType,
} from "./types.js";

export function buildSpec(
  config: ExtractorConfig,
  extractions: readonly RouteExtraction[],
  diagnostics: readonly ApiDiagnostic[],
): ApiSpec {
  const routes = extractions
    .map((extraction) => applyOverride(extraction, config.overrides))
    .filter((overridden): overridden is RouteExtraction => overridden !== undefined)
    .filter((overridden) => !isPathBlacklisted(overridden.route.pathTemplate, config.blacklist.paths))
    .map(
      (overridden): ApiRouteSpec => ({
        method: overridden.route.method,
        pathTemplate: overridden.route.pathTemplate,
        urlTemplate: buildUrlTemplate(config.baseUrl, overridden.route.pathTemplate),
        handler: overridden.route.handler,
        pathParams: materializeParameters(overridden.pathParams, "path", config.blacklist.params),
        queryParams: materializeParameters(overridden.queryParams, "query", config.blacklist.params),
        bodyParams: materializeParameters(overridden.bodyParams, "body", config.blacklist.params),
        source: overridden.route.source,
        diagnostics: filterDiagnostics(overridden.diagnostics, overridden.route.method, overridden.route.pathTemplate),
      }),
    );

  return {
    rootDir: config.rootDir,
    routeFile: config.routeFile,
    routes: sortedReadonly(routes, compareRoutes),
    diagnostics,
  };
}

function compareRoutes(left: ApiRouteSpec, right: ApiRouteSpec): number {
  if (left.pathTemplate !== right.pathTemplate) {
    return left.pathTemplate.localeCompare(right.pathTemplate);
  }
  return left.method.localeCompare(right.method);
}

function materializeParameters(
  parameters: readonly CollectedParameter[],
  location: ParameterLocation,
  blacklistedNames: readonly string[],
): readonly ApiParameterSpec[] {
  const validParameters = parameters
    .filter((parameter) => parameter.location === location)
    .filter((parameter) => isValidCanonicalPath(parameter.canonicalPath))
    .filter((parameter) => !isParamBlacklisted(extractPathName(parameter.canonicalPath), blacklistedNames));

  const deduped = new Map<string, ApiParameterSpec>();
  validParameters.forEach((parameter) => {
    const name = extractPathName(parameter.canonicalPath);
    const existing = deduped.get(parameter.canonicalPath);
    if (existing === undefined) {
      deduped.set(parameter.canonicalPath, {
        name,
        canonicalPath: parameter.canonicalPath,
        location,
        valueType: normalizeValueType(parameter.valueType, location),
        sources: [parameter.source],
      });
      return;
    }

    deduped.set(parameter.canonicalPath, {
      ...existing,
      valueType: mergeValueTypes(existing.valueType, normalizeValueType(parameter.valueType, location)),
      sources: [...existing.sources, parameter.source],
    });
  });

  return sortedReadonly(
    Array.from(deduped.values()).map((spec) => ({
      ...spec,
      sources: sortedReadonly(spec.sources, compareLocations),
    })),
    compareParameters,
  );
}

function isValidCanonicalPath(canonicalPath: string): boolean {
  return canonicalPath.length > 0 && !canonicalPath.endsWith(".") && !canonicalPath.includes("..");
}

function mergeValueTypes(left: ValueType | undefined, right: ValueType | undefined): ValueType | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined || left === right) {
    return left;
  }
  if (left === "array" && right.endsWith("[]")) {
    return right;
  }
  if (right === "array" && left.endsWith("[]")) {
    return left;
  }

  const variants = new Set([...left.split(" | "), ...right.split(" | ")]);
  const merged = [...variants].sort((a, b) => a.localeCompare(b)).join(" | ");
  if (isValueType(merged)) {
    return merged;
  }
  return left;
}

function normalizeValueType(valueType: ValueType | undefined, location: ParameterLocation): ValueType {
  if (valueType !== undefined) {
    return valueType;
  }
  return location === "body" ? "unknown" : "string";
}

function compareParameters(left: ApiParameterSpec, right: ApiParameterSpec): number {
  return left.canonicalPath.localeCompare(right.canonicalPath);
}

function compareLocations(left: SourceLocation, right: SourceLocation): number {
  if (left.filePath !== right.filePath) {
    return left.filePath.localeCompare(right.filePath);
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.column - right.column;
}

function buildUrlTemplate(baseUrl: string | undefined, pathTemplate: string): string | undefined {
  if (baseUrl === undefined || baseUrl.length === 0) {
    return undefined;
  }
  return `${baseUrl.replace(/\/$/, "")}${pathTemplate}`;
}

function isPathBlacklisted(pathTemplate: string, blacklistedPaths: readonly string[]): boolean {
  return blacklistedPaths.includes(pathTemplate);
}

function isParamBlacklisted(name: string, blacklistedNames: readonly string[]): boolean {
  return blacklistedNames.includes(name);
}

function filterDiagnostics(
  diagnostics: readonly ApiDiagnostic[],
  method: HttpMethod,
  pathTemplate: string,
): readonly ApiDiagnostic[] {
  const routeKey = `${method} ${pathTemplate}`;
  return diagnostics.filter((diagnostic) => diagnostic.routeKey === undefined || diagnostic.routeKey === routeKey);
}

function applyOverride(extraction: RouteExtraction, overrides: readonly RouteOverride[]): RouteExtraction | undefined {
  const matchingOverrides = overrides.filter(
    (override) =>
      override.path === extraction.route.pathTemplate &&
      (override.method === undefined || override.method === extraction.route.method),
  );

  if (matchingOverrides.some((override) => override.skip === true)) {
    return undefined;
  }

  return matchingOverrides.reduce<RouteExtraction>(
    (current, override) => ({
      ...current,
      pathParams: applyOverrideParams(current.pathParams, override, "path"),
      queryParams: applyOverrideParams(current.queryParams, override, "query"),
      bodyParams: applyOverrideParams(current.bodyParams, override, "body"),
    }),
    extraction,
  );
}

function applyOverrideParams(
  parameters: readonly CollectedParameter[],
  override: RouteOverride,
  location: ParameterLocation,
): readonly CollectedParameter[] {
  const removeSet = new Set(override.removeParams ?? []);
  const filtered = parameters.filter((parameter) => !removeSet.has(extractPathName(parameter.canonicalPath)));

  const additions = (override.addParams ?? [])
    .filter((addition) => addition.location === location)
    .map(
      (addition): CollectedParameter => ({
        location,
        canonicalPath: addition.canonicalPath ?? normalizePathSegments([addition.name]),
        valueType: undefined,
        source: { filePath: "config", line: 1, column: 1 },
      }),
    );

  return [...filtered, ...additions];
}
