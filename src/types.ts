import type {
  RouteOverride as ConfigRouteOverride,
  RouteOverrideParameter as ConfigRouteOverrideParameter,
  ParameterLocation,
} from "./config-schema.js";

export const HttpMethodMap = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  del: "DELETE",
} as const;

export type HttpMethod = (typeof HttpMethodMap)[keyof typeof HttpMethodMap];
export type CppHttpMethod = keyof typeof HttpMethodMap;

const PRIMITIVE_BASES = ["string", "boolean", "object", "number", "array", "uint", "integer"] as const;

type PrimitiveBase = (typeof PRIMITIVE_BASES)[number];

export type TypePrimitives = PrimitiveBase | `${PrimitiveBase}[]`;

export type ValueType = TypePrimitives | "unknown";

const KNOWN_VALUE_TYPES: ReadonlySet<string> = new Set([
  ...PRIMITIVE_BASES,
  ...PRIMITIVE_BASES.map((p) => `${p}[]`),
  "unknown",
]);

export function isValueType(value: string): value is ValueType {
  return value.split(" | ").every((part) => KNOWN_VALUE_TYPES.has(part));
}

const NUMERIC_TYPES_NARROWEST_FIRST: readonly string[] = ["uint", "integer"];

export function mergeValueTypes(left: ValueType | undefined, right: ValueType | undefined): ValueType | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined || left === right) {
    return left;
  }
  const variants = new Set([...left.split(" | "), ...right.split(" | ")]);
  // A typed array such as `string[]` says more than `is_array()` does.
  if ([...variants].some((type) => type.endsWith("[]"))) {
    variants.delete("array");
  }
  // Reads of one value narrow it rather than widen it: `is_uint32_t(x)` rejects what
  // `std::stoi(x)` would accept, and a default of 10 says nothing about the sign. A float
  // read stays, since `is_number_integer()` and `is_number_float()` are usually alternatives.
  const narrowestNumeric = NUMERIC_TYPES_NARROWEST_FIRST.find((type) => variants.has(type));
  NUMERIC_TYPES_NARROWEST_FIRST.filter((type) => type !== narrowestNumeric).forEach((type) => variants.delete(type));
  const merged = [...variants].sort((a, b) => a.localeCompare(b)).join(" | ");
  if (isValueType(merged)) {
    return merged;
  }
  return left;
}

export interface SourceLocation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
}

export interface ApiDiagnostic {
  readonly level: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly routeKey: string | undefined;
  readonly source: SourceLocation | undefined;
}

export interface ApiParameterSpec {
  readonly name: string;
  readonly canonicalPath: string;
  readonly location: ParameterLocation;
  readonly valueType: ValueType | undefined;
  readonly sources: readonly SourceLocation[];
}

export interface ApiRouteSpec {
  readonly method: HttpMethod;
  readonly pathTemplate: string;
  readonly urlTemplate: string | undefined;
  readonly handler: string;
  readonly pathParams: readonly ApiParameterSpec[];
  readonly queryParams: readonly ApiParameterSpec[];
  readonly bodyParams: readonly ApiParameterSpec[];
  readonly source: SourceLocation;
  readonly diagnostics: readonly ApiDiagnostic[];
}

export interface ApiSpec {
  readonly rootDir: string;
  readonly routeFile: string;
  /** Absent from output written before these fields existed. */
  readonly sourceBranch?: string;
  readonly sourceCommit?: string;
  readonly routes: readonly ApiRouteSpec[];
  readonly diagnostics: readonly ApiDiagnostic[];
}

export type RouteOverrideParameter = ConfigRouteOverrideParameter;
export type RouteOverride = ConfigRouteOverride;
export type { ParameterLocation };

export interface DebugConfig {
  readonly enabled: boolean;
  readonly routeFilter: string | undefined;
}

export interface ExtractorConfig {
  readonly rootDir: string;
  readonly routeFile: string;
  readonly sourceBranch: string;
  readonly outputPath: string;
  readonly diagnosticsOutputPath: string | undefined;
  readonly baseUrl: string | undefined;
  readonly maxCallDepth: number;
  readonly failOnDiagnostics: boolean;
  readonly failOnUnresolved: boolean;
  readonly blacklist: {
    readonly paths: readonly string[];
    readonly params: readonly string[];
  };
  readonly includeHelpers: readonly string[];
  readonly overrides: readonly RouteOverride[];
  readonly debug: DebugConfig;
}

export interface CliOptions {
  readonly command: "extract";
  readonly configPath: string | undefined;
  readonly sourceBranch: string | undefined;
  readonly outputPath: string | undefined;
  readonly baseUrl: string | undefined;
  readonly maxCallDepth: number | undefined;
  readonly failOnDiagnostics: boolean | undefined;
  readonly failOnUnresolved: boolean | undefined;
  readonly verbose: boolean;
  readonly debugRoute: string | undefined;
  readonly json: boolean;
}

export interface SemanticDiffCliOptions {
  readonly command: "semantic-diff";
  readonly previousPath: string;
  readonly nextPath: string;
  readonly jsonOutputPath: string | undefined;
  readonly markdownOutputPath: string | undefined;
}

export type CommandLineOptions = CliOptions | SemanticDiffCliOptions;

export interface RouteRegistration {
  readonly method: HttpMethod;
  readonly pathTemplate: string;
  readonly handler: string;
  readonly source: SourceLocation;
}

export interface FunctionParameter {
  readonly typeText: string;
  /** Empty for unnamed parameters. */
  readonly name: string;
  readonly hasDefault: boolean;
}

export interface FunctionDefinition {
  readonly name: string;
  /** The name as written in the definition, e.g. `Foo::Bar::baz`. */
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly declaration: string;
  readonly body: string;
  readonly fullText: string;
  readonly source: SourceLocation;
  readonly parameters: readonly FunctionParameter[];
}

export interface AliasTarget {
  readonly location:
    | ParameterLocation
    | "params-root"
    | "query-root"
    | "body-root"
    /** The http_req object itself; `->params` / `->body` resolve from it. */
    | "request-root"
    /** A key/value pair from iterating the params map. */
    | "param-entry"
    /** The key of such a pair: comparing it or looking it up names a parameter. */
    | "param-key"
    /** The iterator from `params.find("x")`; segments name that parameter. */
    | "param-lookup"
    /** A key from iterating a JSON object's items; segments locate that object. */
    | "body-key";
  readonly segments: readonly string[];
}

export interface ExtractionContext {
  readonly aliasTargets: ReadonlyMap<string, AliasTarget>;
  /** String arguments bound to the parameters of the function being analyzed. */
  readonly boundStrings: ReadonlyMap<string, string>;
  readonly constants: ReadonlyMap<string, string>;
  readonly functions: ReadonlyMap<string, FunctionDefinition>;
  readonly diagnostics: DiagnosticCollector;
  readonly maxCallDepth: number;
  readonly pathParamNames: ReadonlySet<string>;
}

export interface CollectedParameter {
  readonly location: ParameterLocation;
  readonly canonicalPath: string;
  readonly valueType: ValueType | undefined;
  readonly source: SourceLocation;
}

export interface RouteExtraction {
  readonly route: RouteRegistration;
  readonly pathParams: readonly CollectedParameter[];
  readonly queryParams: readonly CollectedParameter[];
  readonly bodyParams: readonly CollectedParameter[];
  readonly diagnostics: readonly ApiDiagnostic[];
}

export interface DiagnosticCollector {
  add(diagnostic: ApiDiagnostic): void;
  snapshot(): readonly ApiDiagnostic[];
}
