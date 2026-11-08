import type { ParameterLocation } from "../config-schema.js";
import { isValueType, mergeValueTypes } from "../types.js";
import { MAP_KEY_SEGMENT } from "../text.js";
import type { CollectedParameter, RouteRegistration, ValueType } from "../types.js";

const WILDCARD_SUFFIX = `.${MAP_KEY_SEGMENT}`;

export class ParameterCollector {
  readonly #path = new Map<string, CollectedParameter>();
  readonly #query = new Map<string, CollectedParameter>();
  readonly #body = new Map<string, CollectedParameter>();
  readonly #bodyTypeHints = new Map<string, ValueType>();
  readonly #overwrittenBodyPaths = new Set<string>();
  readonly #rejectedBodyPaths = new Set<string>();
  readonly #mirroredBodyPaths = new Set<string>();
  readonly #queryMirrorPrefixes = new Set<string>();

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
      this.#mirrorToBody(parameter);
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
      this.#mirroredBodyPaths.delete(parameter.canonicalPath);
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

  /**
   * A loop over the body refuses or skips this key, so it never reaches the params
   * map. Code elsewhere can still read the field directly, and those reads count.
   */
  markBodyPathRejected(canonicalPath: string): void {
    this.#rejectedBodyPaths.add(canonicalPath);
    if (this.#mirroredBodyPaths.delete(canonicalPath)) {
      this.#body.delete(canonicalPath);
    }
  }

  /**
   * The fields of this JSON object are copied into the params map, so every query
   * parameter read from now on can also be sent as one of its fields.
   */
  mirrorQueryParamsTo(canonicalPrefix: string): void {
    this.#queryMirrorPrefixes.add(canonicalPrefix);
  }

  #mirrorToBody(parameter: CollectedParameter): void {
    for (const prefix of this.#queryMirrorPrefixes) {
      const canonicalPath = `${prefix}.${parameter.canonicalPath}`;
      if (this.#rejectedBodyPaths.has(canonicalPath)) {
        continue;
      }
      const isDirectRead = this.#body.has(canonicalPath) && !this.#mirroredBodyPaths.has(canonicalPath);
      this.add({ ...parameter, location: "body", canonicalPath });
      if (!isDirectRead) {
        this.#mirroredBodyPaths.add(canonicalPath);
      }
    }
  }

  /**
   * `x.*` only says anything when no field of x is named, and it supplies a type
   * for named fields that have none.
   */
  #bodySnapshot(): readonly CollectedParameter[] {
    const parameters = resolveArrayItems(
      [...this.#body.values()].map((parameter) => ({
        ...parameter,
        valueType: mergeValueTypes(parameter.valueType, this.#bodyTypeHints.get(parameter.canonicalPath)),
      })),
    );
    const wildcards = new Map(
      parameters.filter((parameter) => parameter.canonicalPath.endsWith(WILDCARD_SUFFIX)).map((parameter) => [parentPrefix(parameter.canonicalPath), parameter]),
    );
    const namedParents = new Set(
      parameters.filter((parameter) => !parameter.canonicalPath.endsWith(WILDCARD_SUFFIX)).map((parameter) => parentPrefix(parameter.canonicalPath)),
    );

    return parameters
      .filter((parameter) => !parameter.canonicalPath.endsWith(WILDCARD_SUFFIX) || !namedParents.has(parentPrefix(parameter.canonicalPath)))
      .map((parameter) => {
        const wildcardType = wildcards.get(parentPrefix(parameter.canonicalPath))?.valueType;
        return parameter.valueType === undefined && wildcardType !== undefined && !wildcardType.includes(" | ") ?
            { ...parameter, valueType: wildcardType }
          : parameter;
      });
  }

  snapshot(location: ParameterLocation): readonly CollectedParameter[] {
    switch (location) {
      case "path":
        return [...this.#path.values()];
      case "query":
        return [...this.#query.values()];
      case "body":
        return this.#bodySnapshot();
      default: {
        const _exhaustiveCheck: never = location;
        // eslint-disable-next-line
        throw new Error(`Unhandled case: ${_exhaustiveCheck}`);
      }
    }
  }
}

function isArrayType(valueType: ValueType | undefined): boolean {
  return valueType === "array" || valueType?.endsWith("[]") === true;
}

/**
 * `.items()` also works on a JSON array, as in `schema_changes["fields"].items()`, so
 * `x.*` means `x[]` once x is known to be an array, wherever in the code that was checked.
 */
function resolveArrayItems(parameters: readonly CollectedParameter[]): readonly CollectedParameter[] {
  const types = new Map(parameters.map((parameter) => [parameter.canonicalPath, parameter.valueType]));
  const rewritePath = (canonicalPath: string): string => {
    let path = canonicalPath;
    let wildcard = path.indexOf(WILDCARD_SUFFIX);
    while (wildcard >= 0) {
      const prefix = path.slice(0, wildcard);
      const end = wildcard + WILDCARD_SUFFIX.length;
      const isWholeSegment = end === path.length || path[end] === "." || path[end] === "[";
      if (isWholeSegment && isArrayType(types.get(prefix))) {
        path = `${prefix}[]${path.slice(end)}`;
      }
      wildcard = path.indexOf(WILDCARD_SUFFIX, wildcard + 1);
    }
    return path;
  };

  const merged = new Map<string, CollectedParameter>();
  const addMerged = (parameter: CollectedParameter): void => {
    merged.set(parameter.canonicalPath, mergeCollectedParameter(merged.get(parameter.canonicalPath), parameter));
  };
  parameters.forEach((parameter) => {
    const canonicalPath = rewritePath(parameter.canonicalPath);
    if (canonicalPath === parameter.canonicalPath) {
      addMerged(parameter);
    } else if (canonicalPath.endsWith("[]")) {
      // `x[]` typed T is how the rest of the spec writes `x` typed T[].
      const itemType = parameter.valueType === undefined ? undefined : `${parameter.valueType}[]`;
      addMerged({
        ...parameter,
        canonicalPath: canonicalPath.slice(0, -2),
        valueType: itemType !== undefined && isValueType(itemType) ? itemType : undefined,
      });
    } else {
      addMerged({ ...parameter, canonicalPath });
    }
  });
  return [...merged.values()];
}

/** The path of the object this one is a direct field of, with the field name removed. */
function parentPrefix(canonicalPath: string): string {
  return canonicalPath.slice(0, canonicalPath.lastIndexOf(".") + 1);
}

function mergeCollectedParameter(
  existing: CollectedParameter | undefined,
  incoming: CollectedParameter,
): CollectedParameter {
  if (existing === undefined) {
    return incoming;
  }

  // Keep the first read as the citation: validation comes first, while a later
  // read can be unrelated, such as masking a credential for the response.
  return {
    ...existing,
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
