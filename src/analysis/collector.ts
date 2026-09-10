import type { ParameterLocation } from "../config-schema.js";
import { isValueType } from "../types.js";
import type {
  CollectedParameter,
  RouteRegistration,
  ValueType,
} from "../types.js";

export class ParameterCollector {
  readonly #path = new Map<string, CollectedParameter>();
  readonly #query = new Map<string, CollectedParameter>();
  readonly #body = new Map<string, CollectedParameter>();

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
      this.#body.set(
        parameter.canonicalPath,
        mergeCollectedParameter(
          this.#body.get(parameter.canonicalPath),
          parameter,
        ),
      );
    }
  }

  snapshot(location: ParameterLocation): readonly CollectedParameter[] {
    switch (location) {
      case "path":
        return [...this.#path.values()];
      case "query":
        return [...this.#query.values()];
      case "body":
        return [...this.#body.values()];
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

function mergeValueTypes(
  left: ValueType | undefined,
  right: ValueType | undefined,
): ValueType | undefined {
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
