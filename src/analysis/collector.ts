import type { ParameterLocation } from "../config-schema.js";
import { mergeValueTypes } from "../types.js";
import type { CollectedParameter, RouteRegistration, ValueType } from "../types.js";

export class ParameterCollector {
  readonly #path = new Map<string, CollectedParameter>();
  readonly #query = new Map<string, CollectedParameter>();
  readonly #body = new Map<string, CollectedParameter>();
  readonly #bodyTypeHints = new Map<string, ValueType>();
  readonly #overwrittenBodyPaths = new Set<string>();

  constructor(route: RouteRegistration) {
    for (const parameter of collectPathParams(route)) {
      this.#path.set(parameter.canonicalPath, parameter);
    }
  }

  add(parameter: CollectedParameter): void {
    if (parameter.location === "path") {
      this.#path.set(
        parameter.canonicalPath,
        mergeCollectedParameter(
          this.#path.get(parameter.canonicalPath),
          parameter,
        ),
      );
      return;
    }
    if (parameter.location === "query") {
      this.#query.set(
        parameter.canonicalPath,
        mergeCollectedParameter(
          this.#query.get(parameter.canonicalPath),
          parameter,
        ),
      );
      return;
    }
    if (parameter.location === "body") {
      if (this.#overwrittenBodyPaths.has(parameter.canonicalPath)) {
        return;
      }
      this.#body.set(
        parameter.canonicalPath,
        mergeCollectedParameter(
          this.#body.get(parameter.canonicalPath),
          parameter,
        ),
      );
    }
  }

  /** Records the type of a value the server stores, for use if clients also send that field. */
  hintBodyType(canonicalPath: string, valueType: ValueType): void {
    this.#bodyTypeHints.set(canonicalPath, mergeValueTypes(this.#bodyTypeHints.get(canonicalPath), valueType) ?? valueType);
  }

  /** The server always replaces this field, so later reads see its value, not the client's. */
  markBodyPathOverwritten(canonicalPath: string): void {
    if (!this.#body.has(canonicalPath)) {
      this.#overwrittenBodyPaths.add(canonicalPath);
    }
  }

  snapshot(location: ParameterLocation): readonly CollectedParameter[] {
    switch (location) {
      case "path":
        return [...this.#path.values()];
      case "query":
        return [...this.#query.values()];
      case "body":
        return [...this.#body.values()].map((parameter) => ({
          ...parameter,
          valueType: mergeValueTypes(parameter.valueType, this.#bodyTypeHints.get(parameter.canonicalPath)),
        }));
      default: {
        const _exhaustiveCheck: never = location;
        // eslint-disable-next-line
        throw new Error(`Unhandled case: ${_exhaustiveCheck}`);
      }
    }
  }
}

function mergeCollectedParameter(
  existing: CollectedParameter | undefined,
  incoming: CollectedParameter,
): CollectedParameter {
  if (existing === undefined) {
    return incoming;
  }

  return {
    ...incoming,
    valueType: mergeValueTypes(existing.valueType, incoming.valueType),
  };
}

function collectPathParams(
  route: RouteRegistration,
): readonly CollectedParameter[] {
  return route.pathTemplate
    .split("/")
    .filter((part) => part.startsWith(":"))
    .map((part) => part.slice(1))
    .filter((name) => name.length > 0)
    .map(
      (name): CollectedParameter => ({
        location: "path",
        canonicalPath: name,
        valueType: "string",
        source: route.source,
      }),
    );
}
