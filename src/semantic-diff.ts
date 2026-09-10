import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApiParameterSpec,
  ApiRouteSpec,
  ApiSpec,
  HttpMethod,
  ParameterLocation,
  ValueType,
} from "./types.js";

interface DiffSummary {
  readonly changed: boolean;
  readonly addedRoutes: readonly string[];
  readonly removedRoutes: readonly string[];
  readonly changedRoutes: readonly RouteChange[];
}

interface RouteChange {
  readonly routeKey: string;
  readonly addedParams: readonly string[];
  readonly removedParams: readonly string[];
  readonly changedParamTypes: readonly ParamTypeChange[];
}

interface ParamTypeChange {
  readonly parameterKey: string;
  readonly previousType: ValueType | undefined;
  readonly nextType: ValueType | undefined;
}

interface ComparableRoute {
  readonly routeKey: string;
  readonly params: ReadonlyMap<string, ValueType | undefined>;
}

export async function runSemanticDiff(options: {
  readonly previousPath: string;
  readonly nextPath: string;
  readonly jsonOutputPath: string | undefined;
  readonly markdownOutputPath: string | undefined;
}): Promise<DiffSummary> {
  const previous = await readSpec(options.previousPath);
  const next = await readSpec(options.nextPath);
  const summary = diffSpecs(previous, next);

  if (options.jsonOutputPath !== undefined) {
    await writeTextFile(options.jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (options.markdownOutputPath !== undefined) {
    await writeTextFile(options.markdownOutputPath, renderMarkdown(summary));
  }

  return summary;
}

async function readSpec(filePath: string): Promise<ApiSpec> {
  const sourceText = await readFile(filePath, "utf8");
  return JSON.parse(sourceText) as ApiSpec;
}

function diffSpecs(previous: ApiSpec, next: ApiSpec): DiffSummary {
  const previousRoutes = indexRoutes(previous.routes);
  const nextRoutes = indexRoutes(next.routes);

  const addedRoutes = sortedKeysDifference(nextRoutes, previousRoutes);
  const removedRoutes = sortedKeysDifference(previousRoutes, nextRoutes);

  const changedRoutes = [...previousRoutes.keys()]
    .filter((routeKey) => nextRoutes.has(routeKey))
    .map((routeKey) => diffRoute(previousRoutes.get(routeKey), nextRoutes.get(routeKey)))
    .filter((route): route is RouteChange => route !== undefined)
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey));

  return {
    changed:
      addedRoutes.length > 0 ||
      removedRoutes.length > 0 ||
      changedRoutes.length > 0,
    addedRoutes,
    removedRoutes,
    changedRoutes,
  };
}

function indexRoutes(routes: readonly ApiRouteSpec[]): ReadonlyMap<string, ComparableRoute> {
  return new Map(
    routes.map((route) => {
      const routeKey = buildRouteKey(route.method, route.pathTemplate);
      return [
        routeKey,
        {
          routeKey,
          params: new Map([
            ...route.pathParams.map((parameter) => [buildParameterKey("path", parameter), parameter.valueType] as const),
            ...route.queryParams.map((parameter) => [buildParameterKey("query", parameter), parameter.valueType] as const),
            ...route.bodyParams.map((parameter) => [buildParameterKey("body", parameter), parameter.valueType] as const),
          ]),
        },
      ] as const;
    }),
  );
}

function diffRoute(
  previous: ComparableRoute | undefined,
  next: ComparableRoute | undefined,
): RouteChange | undefined {
  if (previous === undefined || next === undefined) {
    return undefined;
  }

  const addedParams = sortedKeysDifference(next.params, previous.params);
  const removedParams = sortedKeysDifference(previous.params, next.params);
  const changedParamTypes = [...previous.params.keys()]
    .filter((parameterKey) => next.params.has(parameterKey))
    .map((parameterKey) => {
      const previousType = previous.params.get(parameterKey);
      const nextType = next.params.get(parameterKey);
      if (previousType === nextType) {
        return undefined;
      }
      return {
        parameterKey,
        previousType,
        nextType,
      } satisfies ParamTypeChange;
    })
    .filter((change): change is ParamTypeChange => change !== undefined)
    .sort((left, right) => left.parameterKey.localeCompare(right.parameterKey));

  if (
    addedParams.length === 0 &&
    removedParams.length === 0 &&
    changedParamTypes.length === 0
  ) {
    return undefined;
  }

  return {
    routeKey: previous.routeKey,
    addedParams,
    removedParams,
    changedParamTypes,
  };
}

function sortedKeysDifference<T>(
  left: ReadonlyMap<string, T>,
  right: ReadonlyMap<string, T>,
): readonly string[] {
  return [...left.keys()]
    .filter((key) => !right.has(key))
    .sort((a, b) => a.localeCompare(b));
}

function buildRouteKey(method: HttpMethod, pathTemplate: string): string {
  return `${method} ${pathTemplate}`;
}

function buildParameterKey(location: ParameterLocation, parameter: ApiParameterSpec): string {
  return `${location}:${parameter.canonicalPath}`;
}

function renderMarkdown(summary: DiffSummary): string {
  if (!summary.changed) {
    return [
      "# Typesense API extraction changed",
      "",
      "The committed extraction diff does not include any API-shape changes that require `openapi.yml` updates.",
      "",
    ].join("\n");
  }

  const lines = [
    "# Update `openapi.yml` for extracted API changes",
    "",
    "The latest committed extractor output includes API-shape changes compared with the previous committed JSON.",
    "",
  ];

  if (summary.addedRoutes.length > 0) {
    lines.push("## Added routes", "");
    lines.push(...summary.addedRoutes.map((routeKey) => `- ${routeKey}`), "");
  }

  if (summary.removedRoutes.length > 0) {
    lines.push("## Removed routes", "");
    lines.push(...summary.removedRoutes.map((routeKey) => `- ${routeKey}`), "");
  }

  if (summary.changedRoutes.length > 0) {
    lines.push("## Changed routes", "");
    summary.changedRoutes.forEach((route) => {
      lines.push(`### ${route.routeKey}`, "");
      if (route.addedParams.length > 0) {
        lines.push(...route.addedParams.map((parameter) => `- Added parameter: ${parameter}`));
      }
      if (route.removedParams.length > 0) {
        lines.push(...route.removedParams.map((parameter) => `- Removed parameter: ${parameter}`));
      }
      if (route.changedParamTypes.length > 0) {
        lines.push(
          ...route.changedParamTypes.map(
            (change) =>
              `- Changed parameter type: ${change.parameterKey} (${formatType(change.previousType)} -> ${formatType(change.nextType)})`,
          ),
        );
      }
      lines.push("");
    });
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatType(valueType: ValueType | undefined): string {
  return valueType ?? "undefined";
}

async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}
