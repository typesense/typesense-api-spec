import { extractRouteData } from "../../src/analysis.js";
import { indexFunctions } from "../../src/symbols.js";
import type { CollectedParameter, HttpMethod } from "../../src/types.js";
import { inMemoryRepo, nextBranch, stubGithub } from "./fake-github.js";

export interface ExtractOptions {
  readonly constants?: Readonly<Record<string, string>>;
  readonly pathTemplate?: string;
  readonly method?: HttpMethod;
  readonly maxCallDepth?: number;
}

export interface Extracted {
  readonly path: readonly string[];
  readonly query: readonly string[];
  readonly body: readonly string[];
  /** canonicalPath -> valueType, across all locations. */
  readonly types: ReadonlyMap<string, string | undefined>;
  readonly diagnosticCodes: readonly string[];
}

/** Runs the real indexer and analyzer on C++ whose route handler is `handler`. */
export async function extractHandler(cpp: string, options: ExtractOptions = {}): Promise<Extracted> {
  const restore = stubGithub(inMemoryRepo({ "src/core_api.cpp": cpp }));
  try {
    const functions = await indexFunctions("", [], nextBranch());
    const result = extractRouteData(
      {
        method: options.method ?? "POST",
        pathTemplate: options.pathTemplate ?? "/things",
        handler: "handler",
        source: { filePath: "fixture", line: 1, column: 1 },
      },
      functions,
      new Map(Object.entries(options.constants ?? {})),
      options.maxCallDepth ?? 8,
      { enabled: false, routeFilter: undefined },
    );
    const names = (parameters: readonly CollectedParameter[]): readonly string[] =>
      parameters.map((parameter) => parameter.canonicalPath).sort();
    return {
      path: names(result.pathParams),
      query: names(result.queryParams),
      body: names(result.bodyParams),
      types: new Map(
        [...result.pathParams, ...result.queryParams, ...result.bodyParams].map(
          (parameter) => [parameter.canonicalPath, parameter.valueType] as const,
        ),
      ),
      diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code),
    };
  } finally {
    restore();
  }
}

/** Wraps statements in a handler whose JSON body is parsed into `body`. */
export function handlerWithBody(statements: string, helpers = ""): string {
  return `${helpers}
bool handler(const std::shared_ptr<http_req>& req, const std::shared_ptr<http_res>& res) {
  nlohmann::json body = nlohmann::json::parse(req->body);
  ${statements}
  return true;
}`;
}
