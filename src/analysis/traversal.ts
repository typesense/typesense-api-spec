import { parseCppCached, findFirstNamedNode, walkNamed, childForField, extractDeclaratorName } from "../cpp-ast.js";
import { MAP_KEY_SEGMENT, normalizePathSegments } from "../text.js";
import type { SyntaxNode } from "tree-sitter";
import { isValueType } from "../types.js";
import type {
  AliasTarget,
  ExtractionContext,
  FunctionDefinition,
  SourceLocation,
  TypePrimitives,
  ValueType,
} from "../types.js";
import type { ParameterCollector } from "./collector.js";
import {
  bootstrapAliases,
  resolveExpressionNode,
  resolveLoopItemTarget,
  resolveStringTokenNode,
} from "./resolution.js";
import {
  extractIdentifierName,
  extractLoopAliasName,
  extractSubscriptIndexNode,
  isConstantIdentifier,
  parseCallExpressionNode,
  unwrapExpressionNode,
} from "./syntax.js";
import type { ParsedCall } from "./syntax.js";

const bodyMethods = new Set(["count", "find", "contains", "at", "value"]);

const typeMethods = {
  is_string: "string",
  is_boolean: "boolean",
  is_object: "object",
  is_array: "array",
  is_number_unsigned: "uint",
  is_number_integer: "integer",
  is_number_float: "number",
  is_number: "number",
} as const satisfies Record<string, TypePrimitives>;

/** Query values are strings on the wire, so converting or validating one declares its real type. */
const queryValueReaders = {
  stoi: "integer",
  stol: "integer",
  stoll: "integer",
  stoul: "uint",
  stoull: "uint",
  stof: "number",
  stod: "number",
  is_int32_t: "integer",
  is_int64_t: "integer",
  is_uint32_t: "uint",
  is_uint64_t: "uint",
  is_float: "number",
  is_bool: "boolean",
} as const satisfies Record<string, TypePrimitives>;

const typeTemplates = {
  "std::string": "string",
  string: "string",
  bool: "boolean",
  size_t: "uint",
  uint32_t: "uint",
  uint64_t: "uint",
  int: "integer",
  int32_t: "integer",
  int64_t: "integer",
  float: "number",
  double: "number",
  "std::vector<std::string>": "string[]",
  "std::vector<uint32_t>": "uint[]",
} as const satisfies Record<string, TypePrimitives>;

type TypeTemplateName = keyof typeof typeTemplates;
type TypeMethodName = keyof typeof typeMethods;
type InferredValueType = (typeof typeMethods)[TypeMethodName] | (typeof typeTemplates)[TypeTemplateName];

interface KeyTable {
  /** The entry that names each key, so a parameter can cite it. */
  readonly keys: readonly { readonly name: string; readonly node: SyntaxNode }[];
  readonly valueType: TypePrimitives | undefined;
}

interface AnalysisState {
  readonly aliases: Map<string, AliasTarget>;
  readonly constants: Map<string, string>;
  readonly valueTypes: Map<string, TypePrimitives>;
  /** Enclosing scope; assignments propagate to it unless the name is declared here. */
  readonly parent: AnalysisState | undefined;
  /** Variables declared in this scope (they shadow outer ones), with their declared type. */
  readonly declared: Map<string, string>;
  /** Lambdas assigned to local variables, followed when they are called. */
  readonly lambdas: Map<string, SyntaxNode>;
  /** Local tables of known keys, such as `{{QUERY_BY, &search_fields}, ...}`. */
  readonly keyTables: Map<string, KeyTable>;
  readonly definition: FunctionDefinition;
  readonly collector: ParameterCollector;
  readonly pathParamNames: ReadonlySet<string>;
  readonly routeKey: string;
  readonly debug: (message: string) => void;
}

export function analyzeFunction(
  definition: FunctionDefinition,
  context: ExtractionContext,
  collector: ParameterCollector,
  visited: Set<string>,
  depth: number,
  routeKey: string,
  debug: (message: string) => void,
): void {
  // A route handler receives the request; a helper only has what its caller passed.
  const inheritedAliases =
    depth === 0 ? bootstrapAliases(definition.parameters, context.aliasTargets) : new Map(context.aliasTargets);
  const visitKey = serializeVisitKey(definition.qualifiedName, inheritedAliases, context.boundStrings);
  if (visited.has(visitKey)) {
    return;
  }
  visited.add(visitKey);

  if (depth > context.maxCallDepth) {
    context.diagnostics.add({
      level: "warning",
      code: "max_call_depth_reached",
      message: `Stopped traversing helper calls at ${definition.name}.`,
      routeKey,
      source: definition.source,
    });
    return;
  }

  const rootNode = parseCppCached(definition.fullText);
  const functionNode = findFirstNamedNode(rootNode, "function_definition");
  const bodyNode = functionNode === undefined ? undefined : findFirstNamedNode(functionNode, "compound_statement");
  if (!bodyNode) {
    context.diagnostics.add({
      level: "error",
      code: "function_ast_missing",
      message: `Could not parse AST for ${definition.name}.`,
      routeKey,
      source: definition.source,
    });
    return;
  }

  // A parameter hides any constant of the same name, unless the caller passed a
  // known string for it.
  const constants = new Map(context.constants);
  applyClassConstants(constants, definition.qualifiedName);
  definition.parameters.forEach((parameter) => constants.delete(parameter.name));
  context.boundStrings.forEach((value, name) => constants.set(name, value));

  const state: AnalysisState = {
    aliases: inheritedAliases,
    constants,
    valueTypes: new Map<string, TypePrimitives>(),
    parent: undefined,
    declared: new Map(definition.parameters.map((parameter) => [parameter.name, parameter.typeText])),
    lambdas: new Map<string, SyntaxNode>(),
    keyTables: new Map<string, KeyTable>(),
    definition,
    collector,
    pathParamNames: context.pathParamNames,
    routeKey,
    debug,
  };

  state.debug(`analyzing ${definition.name}`);
  analyzeBlock(bodyNode, state, context, visited, depth);
}

/** Inside `Foo::bar`, a bare `KEY` means `Foo::KEY` before any global `KEY`. */
function applyClassConstants(constants: Map<string, string>, qualifiedName: string): void {
  const scopeEnd = qualifiedName.lastIndexOf("::");
  if (scopeEnd < 0) {
    return;
  }
  const prefix = qualifiedName.slice(0, scopeEnd + 2);
  for (const [name, value] of [...constants]) {
    if (name.startsWith(prefix)) {
      constants.set(name.slice(prefix.length), value);
    }
  }
}

function analyzeBlock(
  blockNode: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  for (const statement of blockNode.namedChildren) {
    analyzeStatement(statement, state, context, visited, depth);
  }
}

function analyzeStatement(
  statement: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  // Only appears inside another function after a parse error; see collectFunctionNodes.
  if (statement.type === "function_definition") {
    return;
  }

  if (statement.type === "declaration") {
    handleDeclaration(statement, state, context, visited, depth);
    return;
  }

  if (statement.type === "expression_statement") {
    const expressionNode = statement.namedChildren[0];
    if (expressionNode !== undefined) {
      handleExpression(expressionNode, state, context, visited, depth);
    }
    return;
  }

  if (statement.type === "for_range_loop") {
    handleForRangeLoop(statement, state, context, visited, depth);
    return;
  }

  if (statement.type === "for_statement") {
    handleForLoop(statement, state, context, visited, depth);
    return;
  }

  if (statement.type === "if_statement") {
    const scopedState = cloneState(state);
    analyzeOptionalDeclaration(childForField(statement, "condition"), scopedState, context, visited, depth);
    const consequence = childForField(statement, "consequence");
    if (consequence !== undefined) {
      analyzeStatement(consequence, cloneState(scopedState), context, visited, depth);
    }
    const alternative = childForField(statement, "alternative");
    alternative?.namedChildren.forEach((branch) => {
      analyzeStatement(branch, cloneState(scopedState), context, visited, depth);
    });
    return;
  }

  if (
    statement.type === "while_statement" ||
    statement.type === "do_statement" ||
    statement.type === "switch_statement"
  ) {
    const scopedState = cloneState(state);
    analyzeOptionalDeclaration(childForField(statement, "condition"), scopedState, context, visited, depth);
    const body = childForField(statement, "body");
    if (body !== undefined) {
      analyzeStatement(body, cloneState(scopedState), context, visited, depth);
    }
    return;
  }

  if (statement.type === "case_statement") {
    const valueNode = childForField(statement, "value");
    statement.namedChildren
      .filter((child) => valueNode === undefined || child.id !== valueNode.id)
      .forEach((child) => {
        analyzeStatement(child, state, context, visited, depth);
      });
    return;
  }

  if (statement.type === "try_statement") {
    statement.namedChildren.forEach((child) => {
      const block = child.type === "catch_clause" ? childForField(child, "body") : child;
      if (block !== undefined) {
        analyzeStatement(block, state, context, visited, depth);
      }
    });
    return;
  }

  if (statement.type === "compound_statement") {
    analyzeBlock(statement, cloneState(state), context, visited, depth);
    return;
  }

  walkExpression(statement, state, context, visited, depth);
}

function handleDeclaration(
  statement: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  walkNamed(statement, (child) => {
    if (child.type === "lambda_expression") {
      return false;
    }

    // The statement itself, or one nested in a condition: `if (auto x = ...; ...)`.
    if (child.type === "declaration") {
      child.childrenForFieldName("declarator").forEach((declarator) => {
        const declaredName = extractDeclaratorName(declarator);
        if (declaredName !== undefined) {
          state.declared.set(declaredName, childForField(child, "type")?.text ?? "");
          // A new variable shadows any alias or constant from an outer scope.
          state.aliases.delete(declaredName);
          state.constants.delete(declaredName);
          state.valueTypes.delete(declaredName);
          state.keyTables.delete(declaredName);
        }
      });
    }

    // `auto x = ...;` nests an init_declarator; a condition such as
    // `if (auto x = ...)` puts declarator/value directly on the declaration.
    const isConditionDeclaration = child.type === "declaration" && childForField(child, "value") !== undefined;
    if (child.type !== "init_declarator" && !isConditionDeclaration) {
      return;
    }

    const declaratorNode = childForField(child, "declarator");
    const valueNode = childForField(child, "value");
    const aliasName = extractDeclaratorName(declaratorNode);
    if (aliasName === undefined || valueNode === undefined) {
      return;
    }

    if (valueNode.type === "lambda_expression") {
      state.lambdas.set(aliasName, valueNode);
      return;
    }

    const keyTable = parseKeyTable(childForField(statement, "type"), valueNode, state);
    if (keyTable !== undefined) {
      state.keyTables.set(aliasName, keyTable);
    }

    const lookup = resolveParamLookup(valueNode, state);
    if (lookup !== undefined) {
      state.aliases.set(aliasName, lookup);
      return;
    }

    const literalValue = resolveStringTokenNode(valueNode, state.constants);
    if (literalValue !== undefined && (isConstantIdentifier(aliasName) || isConstDeclaration(statement))) {
      state.constants.set(aliasName, literalValue);
      state.debug(`const ${aliasName} = ${literalValue}`);
    }

    const resolved = resolveExpressionNode(valueNode, state.aliases, state.constants);
    if (resolved !== undefined) {
      state.aliases.set(aliasName, resolved);
      state.debug(`alias ${aliasName} => ${resolved.location}:${normalizePathSegments(resolved.segments)}`);
    }

    const inferredType = resolveValueTypeNode(valueNode, state);
    if (inferredType !== undefined) {
      state.valueTypes.set(aliasName, inferredType);
    }
  });

  walkExpression(statement, state, context, visited, depth);
}

function handleExpression(
  expressionNode: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  walkExpression(expressionNode, state, context, visited, depth);
}

function handleForRangeLoop(
  statement: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  const bodyNode =
    childForField(statement, "body") ?? statement.namedChildren.find((child) => child.type === "compound_statement");
  const iterableNode = childForField(statement, "right");
  if (bodyNode === undefined || iterableNode === undefined) {
    walkExpression(statement, state, context, visited, depth);
    return;
  }

  walkExpression(iterableNode, state, context, visited, depth);

  const scopedState = cloneState(state);
  const bindingNames = structuredBindingNames(statement);
  const aliasName = bindingNames === undefined ? extractLoopAliasName(statement) : undefined;
  if (aliasName === undefined && bindingNames === undefined) {
    analyzeStatement(bodyNode, scopedState, context, visited, depth);
    return;
  }

  for (const name of bindingNames ?? [aliasName ?? ""]) {
    scopedState.declared.set(name, "");
    scopedState.aliases.delete(name);
    scopedState.constants.delete(name);
  }
  const resolved = resolveLoopItemTarget(iterableNode, scopedState.aliases, scopedState.constants);
  if (resolved !== undefined && aliasName !== undefined) {
    scopedState.aliases.set(aliasName, resolved);
    state.debug(`loop ${aliasName} => ${resolved.location}:${normalizePathSegments(resolved.segments)}`);
  }
  // `for (auto& [key, value] : params)` binds the pair's parts directly.
  if (resolved?.location === "param-entry" && bindingNames?.[0] !== undefined) {
    scopedState.aliases.set(bindingNames[0], { location: "param-key", segments: [] });
  }
  if (
    resolved?.location === "body-root" &&
    resolved.segments.at(-1) === MAP_KEY_SEGMENT &&
    bindingNames !== undefined
  ) {
    const [keyName, valueName] = bindingNames;
    if (keyName !== undefined) {
      scopedState.aliases.set(keyName, { location: "body-key", segments: resolved.segments.slice(0, -1) });
    }
    if (valueName !== undefined) {
      scopedState.aliases.set(valueName, resolved);
    }
  }

  analyzeStatement(bodyNode, scopedState, context, visited, depth);
}

function structuredBindingNames(statement: SyntaxNode): readonly string[] | undefined {
  return childForField(statement, "declarator")
    ?.descendantsOfType("structured_binding_declarator")[0]
    ?.namedChildren.filter((child) => child.type === "identifier")
    .map((child) => child.text);
}

/** `req->params.find("x")`: its iterator's `->second` is the value of x. */
function resolveParamLookup(valueNode: SyntaxNode, state: AnalysisState): AliasTarget | undefined {
  const normalized = unwrapExpressionNode(valueNode);
  const callInfo = normalized.type === "call_expression" ? parseCallExpressionNode(normalized) : undefined;
  const keyNode = callInfo?.arguments[0];
  if (callInfo?.methodName !== "find" || callInfo.baseNode === undefined || keyNode === undefined) {
    return undefined;
  }

  const base = resolveExpressionNode(callInfo.baseNode, state.aliases, state.constants);
  const key = resolveStringTokenNode(keyNode, state.constants);
  const isParamsMap =
    (base?.location === "params-root" || base?.location === "query-root") && base.segments.length === 0;
  return isParamsMap && key !== undefined ? { location: "param-lookup", segments: [key] } : undefined;
}

const KEY_TABLE_TYPE = /^(?:[\w:]*::)?(?:unordered_map|map|sparse_hash_map)\s*<\s*std::string\s*,\s*(.+)>$/;
const KEY_SET_TYPE = /^(?:[\w:]*::)?(?:unordered_set|set)\s*<\s*std::string\s*>$/;

/** Reads `std::unordered_map<std::string, T*> x = {{KEY, &value}, ...}` or a set of keys. */
function parseKeyTable(
  typeNode: SyntaxNode | undefined,
  valueNode: SyntaxNode,
  state: AnalysisState,
): KeyTable | undefined {
  if (typeNode === undefined || valueNode.type !== "initializer_list") {
    return undefined;
  }

  const mapMatch = KEY_TABLE_TYPE.exec(typeNode.text.trim());
  if (mapMatch === null && !KEY_SET_TYPE.test(typeNode.text.trim())) {
    return undefined;
  }

  const keys = valueNode.namedChildren.flatMap((entry) => {
    const keyNode = entry.type === "initializer_list" ? entry.namedChildren[0] : entry;
    const key = keyNode === undefined ? undefined : resolveStringTokenNode(keyNode, state.constants);
    return key === undefined || keyNode === undefined ? [] : [{ name: key, node: keyNode }];
  });
  return { keys, valueType: mapMatch?.[1] === undefined ? undefined : inferTypeFromParameter(mapMatch[1]) };
}

function handleForLoop(
  statement: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  const scopedState = cloneState(state);
  const body = childForField(statement, "body");
  statement.namedChildren
    .filter((child) => body === undefined || child.id !== body.id)
    .forEach((child) => {
      analyzeOptionalDeclaration(child, scopedState, context, visited, depth);
    });
  if (body !== undefined) {
    analyzeStatement(body, cloneState(scopedState), context, visited, depth);
  }
}

function analyzeOptionalDeclaration(
  node: SyntaxNode | undefined,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  if (node !== undefined) {
    handleDeclaration(node, state, context, visited, depth);
  }
}

function walkExpression(
  node: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  walkNamed(node, (currentNode) => {
    if (currentNode.type === "function_definition") {
      return false;
    }

    if (currentNode.type === "lambda_expression") {
      analyzeLambda(currentNode, state, context, visited, depth, new Map(), new Map());
      return false;
    }

    if (currentNode.type === "assignment_expression") {
      collectAssignmentExpression(currentNode, state);
      // Storing into the params map or body is the server's doing, not a client parameter.
      const rightNode = childForField(currentNode, "right");
      if (rightNode !== undefined && isRequestDataWrite(currentNode, state)) {
        recordBodyWrite(currentNode, rightNode, state, depth);
        walkExpression(rightNode, state, context, visited, depth);
        return false;
      }
      return;
    }

    if (currentNode.type === "call_expression") {
      collectCallExpression(currentNode, state, context);
      collectHelperCallExpression(currentNode, state, context, visited, depth);
      return;
    }

    if (currentNode.type === "binary_expression") {
      collectBinaryExpression(currentNode, state);
      return;
    }

    if (currentNode.type === "subscript_expression") {
      collectSubscriptExpression(currentNode, state);
    }
  });
}

function isRequestDataWrite(assignment: SyntaxNode, state: AnalysisState): boolean {
  const leftNode = childForField(assignment, "left");
  const baseNode = leftNode?.type === "subscript_expression" ? childForField(leftNode, "argument") : undefined;
  const target = baseNode === undefined ? undefined : resolveExpressionNode(baseNode, state.aliases, state.constants);
  return target?.location === "params-root" || target?.location === "query-root" || target?.location === "body-root";
}

function recordBodyWrite(assignment: SyntaxNode, rightNode: SyntaxNode, state: AnalysisState, depth: number): void {
  const leftNode = childForField(assignment, "left");
  const target = leftNode === undefined ? undefined : resolveExpressionNode(leftNode, state.aliases, state.constants);
  if (target?.location !== "body-root") {
    return;
  }

  const typed = materializeTypedParameter(target.segments, resolveValueTypeNode(rightNode, state));
  if (typed === undefined) {
    return;
  }
  if (typed.valueType !== undefined) {
    state.collector.hintBodyType(typed.canonicalPath, typed.valueType);
  }
  // Only a write at the top level of the handler is certain to run.
  if (depth === 0 && state.parent === undefined) {
    state.collector.markBodyPathOverwritten(typed.canonicalPath);
  }
}

/**
 * `target[item.key()] = ...` copies a JSON object's fields. Copied into the params
 * map, they become search parameters; copied into a new object, it holds them too.
 */
function collectKeyedCopy(leftNode: SyntaxNode | undefined, state: AnalysisState): void {
  if (leftNode?.type !== "subscript_expression") {
    return;
  }
  const baseNode = childForField(leftNode, "argument");
  const indexNode = extractSubscriptIndexNode(leftNode);
  const keyOwner = indexNode === undefined ? undefined : resolveKeyOwner(indexNode, state);
  if (baseNode === undefined || keyOwner?.location !== "body-root") {
    return;
  }

  const baseTarget = resolveExpressionNode(baseNode, state.aliases, state.constants);
  if (baseTarget?.location === "params-root" || baseTarget?.location === "query-root") {
    state.collector.mirrorQueryParamsTo(normalizePathSegments(keyOwner.segments));
    return;
  }

  const copyName = extractIdentifierName(baseNode);
  if (baseTarget === undefined && copyName !== undefined) {
    assignInScope(state, copyName, (scope) => scope.aliases.set(copyName, keyOwner));
    state.debug(`copy ${copyName} => body:${normalizePathSegments(keyOwner.segments)}`);
  }
}

function collectAssignmentExpression(node: SyntaxNode, state: AnalysisState): void {
  const leftNode = childForField(node, "left");
  const rightNode = childForField(node, "right");
  if (rightNode === undefined) {
    return;
  }

  collectKeyedCopy(leftNode, state);

  const inferredType = resolveValueTypeNode(rightNode, state);
  const aliasName = leftNode === undefined ? undefined : extractIdentifierName(leftNode);
  if (aliasName !== undefined) {
    // `it = req->params.find("y")` moves the iterator to y; any other value leaves no parameter behind it.
    const lookup = resolveParamLookup(rightNode, state);
    const resolved = lookup ?? resolveExpressionNode(rightNode, state.aliases, state.constants);
    if (resolved === undefined && state.aliases.get(aliasName)?.location === "param-lookup") {
      assignInScope(state, aliasName, (scope) => scope.aliases.delete(aliasName));
    }
    if (resolved !== undefined) {
      assignInScope(state, aliasName, (scope) => scope.aliases.set(aliasName, resolved));
      state.debug(`assign ${aliasName} => ${resolved.location}:${normalizePathSegments(resolved.segments)}`);
    }
    if (inferredType !== undefined) {
      assignInScope(state, aliasName, (scope) => scope.valueTypes.set(aliasName, inferredType));
    }
  }

  const rightTarget = resolveExpressionNode(rightNode, state.aliases, state.constants);
  const wrappedAlias = inferWrappedAliasTarget(leftNode, rightTarget, state);
  if (wrappedAlias !== undefined) {
    assignInScope(state, wrappedAlias.aliasName, (scope) =>
      scope.aliases.set(wrappedAlias.aliasName, wrappedAlias.target),
    );
    state.debug(
      `assign ${wrappedAlias.aliasName} => ${wrappedAlias.target.location}:${normalizePathSegments(wrappedAlias.target.segments)}`,
    );
  }

  const target = leftNode === undefined ? undefined : resolveExpressionNode(leftNode, state.aliases, state.constants);
  if (target !== undefined && target.location === "body-root" && leftNode?.type !== "subscript_expression") {
    addParameter(target, [], state, node, inferredType);
  }
}

/** `std::stoi(req->params["x"])` and `StringUtils::is_uint32_t(req->params["x"])` type x. */
function collectQueryValueRead(callInfo: ParsedCall, state: AnalysisState, node: SyntaxNode): void {
  const functionName = callInfo.calleeName.split("::").at(-1) ?? "";
  const valueType =
    Object.hasOwn(queryValueReaders, functionName) ?
      queryValueReaders[functionName as keyof typeof queryValueReaders]
    : undefined;
  const firstArgument = callInfo.arguments[0];
  if (valueType === undefined || firstArgument === undefined) {
    return;
  }

  const target = resolveExpressionNode(firstArgument, state.aliases, state.constants);
  if (target?.location === "params-root" || target?.location === "query-root") {
    addParameter(target, [], state, node, valueType);
  }
}

/** `table.find(key)` where key comes from iterating the params map names every key in the table. */
function collectKeyTableLookup(callInfo: ParsedCall, state: AnalysisState): void {
  const table = callInfo.baseNode?.type === "identifier" ? state.keyTables.get(callInfo.baseNode.text) : undefined;
  const firstArgument = callInfo.arguments[0];
  if (
    table === undefined ||
    firstArgument === undefined ||
    !["find", "count", "contains", "at"].includes(callInfo.methodName ?? "")
  ) {
    return;
  }

  const keyOwner = resolveKeyOwner(firstArgument, state);
  if (keyOwner !== undefined) {
    state.debug(`table lookup ${callInfo.calleeName} => ${table.keys.length} keys`);
    table.keys.forEach((key) => addParameter(keyOwner, [key.name], state, key.node, table.valueType));
  }
}

/** The map whose keys this expression iterates over, if it is one. */
function resolveKeyOwner(node: SyntaxNode, state: AnalysisState): AliasTarget | undefined {
  const resolved = resolveExpressionNode(node, state.aliases, state.constants);
  if (resolved?.location === "param-key") {
    return { location: "params-root", segments: [] };
  }
  if (resolved?.location === "body-key") {
    return { location: "body-root", segments: resolved.segments };
  }

  // `item.key()`, where item comes from iterating a JSON object's items.
  const normalized = unwrapExpressionNode(node);
  const callInfo = normalized.type === "call_expression" ? parseCallExpressionNode(normalized) : undefined;
  if (callInfo?.methodName !== "key" || callInfo.baseNode === undefined) {
    return undefined;
  }
  const item = resolveExpressionNode(callInfo.baseNode, state.aliases, state.constants);
  return item?.location === "body-root" && item.segments.at(-1) === MAP_KEY_SEGMENT ?
      { location: "body-root", segments: item.segments.slice(0, -1) }
    : undefined;
}

function collectCallExpression(node: SyntaxNode, state: AnalysisState, context: ExtractionContext): void {
  const callInfo = parseCallExpressionNode(node);
  if (callInfo === undefined) {
    return;
  }

  collectKeyTableLookup(callInfo, state);
  collectQueryValueRead(callInfo, state, node);

  const normalizedMethodName = callInfo.methodName === undefined ? undefined : normalizeMethodName(callInfo.methodName);

  if (normalizedMethodName === "key") {
    return;
  }

  if (normalizedMethodName === "items") {
    const resolved =
      callInfo.baseNode === undefined ?
        undefined
      : resolveExpressionNode(callInfo.baseNode, state.aliases, state.constants);
    if (resolved !== undefined) {
      addParameter(resolved, [], state, node);
    }
    return;
  }

  if (normalizedMethodName !== undefined && bodyMethods.has(normalizedMethodName)) {
    const resolved =
      callInfo.baseNode === undefined ?
        undefined
      : resolveExpressionNode(callInfo.baseNode, state.aliases, state.constants);
    if (resolved !== undefined) {
      const firstArgument = callInfo.arguments[0];
      const fillsDefault =
        (normalizedMethodName === "count" || normalizedMethodName === "contains" || normalizedMethodName === "find") &&
        firstArgument !== undefined &&
        callInfo.baseNode !== undefined &&
        isDefaultFillCheck(node, normalizedMethodName, callInfo.baseNode, firstArgument);
      if (firstArgument !== undefined && !fillsDefault) {
        const segment = resolveStringTokenNode(firstArgument, state.constants);
        if (segment !== undefined) {
          state.debug(`call ${callInfo.calleeName} => ${segment}`);
          // nlohmann `.value(key, default)`: the default value's type is the field's type.
          const defaultArgument = normalizedMethodName === "value" ? callInfo.arguments[1] : undefined;
          const valueType = defaultArgument === undefined ? undefined : resolveValueTypeNode(defaultArgument, state);
          addParameter(resolved, [segment], state, node, valueType);
          if (
            normalizedMethodName === "find" ||
            normalizedMethodName === "contains" ||
            normalizedMethodName === "count" ||
            normalizedMethodName === "value"
          ) {
            addParameter(resolved, [], state, node, "object");
          }
        }
      }
    }
  }

  const inferredType =
    normalizedMethodName === undefined ? undefined : (
      inferTypeFromCall(normalizedMethodName, callInfo.methodName ?? normalizedMethodName, callInfo.baseNode)
    );
  if (inferredType !== undefined) {
    const resolved =
      callInfo.baseNode === undefined ?
        undefined
      : resolveExpressionNode(callInfo.baseNode, state.aliases, state.constants);
    if (resolved !== undefined) {
      state.debug(`type ${normalizePathSegments(resolved.segments) || "(root)"} => ${inferredType}`);
      addParameter(resolved, [], state, node, inferredType);
    }
  }

  const helperDefinition = findCallDefinition(callInfo, context.functions, state);
  if (helperDefinition !== undefined) {
    collectArgumentTypeHints(node, callInfo.arguments, helperDefinition, state);
  }
}

function collectSubscriptExpression(node: SyntaxNode, state: AnalysisState): void {
  const baseNode = childForField(node, "argument");
  const indexNode = extractSubscriptIndexNode(node);
  if (baseNode === undefined || indexNode === undefined) {
    return;
  }

  const resolved = resolveExpressionNode(baseNode, state.aliases, state.constants);
  if (resolved === undefined) {
    return;
  }

  const segment = resolveStringTokenNode(indexNode, state.constants) ?? "[]";
  state.debug(`subscript ${baseNode.text}[${indexNode.text}] => ${segment}`);
  addParameter(resolved, [segment], state, node);
}

function collectBinaryExpression(node: SyntaxNode, state: AnalysisState): void {
  const operatorNode = childForField(node, "operator");
  if (operatorNode === undefined || (operatorNode.text !== "==" && operatorNode.text !== "!=")) {
    return;
  }

  const leftNode = childForField(node, "left");
  const rightNode = childForField(node, "right");
  if (leftNode === undefined || rightNode === undefined) {
    return;
  }

  collectKeyComparison(leftNode, rightNode, state, node);
  collectKeyComparison(rightNode, leftNode, state, node);

  const leftTarget = resolveExpressionNode(leftNode, state.aliases, state.constants);
  const rightTarget = resolveExpressionNode(rightNode, state.aliases, state.constants);
  const leftType = comparedValueType(rightNode, leftTarget, state);
  const rightType = comparedValueType(leftNode, rightTarget, state);

  if (leftTarget !== undefined && leftType !== undefined) {
    addParameter(leftTarget, [], state, node, leftType);
  }
  if (rightTarget !== undefined && rightType !== undefined) {
    addParameter(rightTarget, [], state, node, rightType);
  }
}

/** Query values are all strings on the wire, so `params["x"] == "true"` declares a boolean. */
function comparedValueType(
  valueNode: SyntaxNode,
  comparedTo: AliasTarget | undefined,
  state: AnalysisState,
): TypePrimitives | undefined {
  const isParam = comparedTo?.location === "params-root" || comparedTo?.location === "query-root";
  if (isParam && (valueNode.text === '"true"' || valueNode.text === '"false"')) {
    return "boolean";
  }
  // `"1"` is only ever a spelling of true or of a number, never a string option.
  if (isParam && valueNode.text === '"1"') {
    return undefined;
  }
  return resolveValueTypeNode(valueNode, state);
}

/** `key == PREFIX`, where key comes from iterating a map, names that key. */
function collectKeyComparison(
  keyNode: SyntaxNode,
  valueNode: SyntaxNode,
  state: AnalysisState,
  node: SyntaxNode,
): void {
  const keyOwner = resolveKeyOwner(keyNode, state);
  const key = keyOwner === undefined ? undefined : resolveStringTokenNode(valueNode, state.constants);
  if (keyOwner === undefined || key === undefined) {
    return;
  }

  const rejection = keyOwner.location === "body-root" ? keyRejection(node, keyOwner, state) : undefined;
  if (rejection !== undefined) {
    const canonicalPath = normalizePathSegments([...keyOwner.segments, key]);
    if (rejection === "refused") {
      state.collector.markBodyPathRefused(canonicalPath);
    } else {
      state.collector.markBodyPathSkipped(canonicalPath);
    }
    return;
  }
  addParameter(keyOwner, [key], state, node);
}

/**
 * `if (item.key() == "x") { continue; }` skips that field, and a branch that returns an
 * error refuses it. A branch that uses the item's value before leaving handles the field.
 */
function keyRejection(
  comparison: SyntaxNode,
  keyOwner: AliasTarget,
  state: AnalysisState,
): "skipped" | "refused" | undefined {
  if (childForField(comparison, "operator")?.text !== "==") {
    return undefined;
  }
  // Any one of `key == "a" || key == "b"` is enough to take the branch.
  let condition = comparison.parent;
  while (
    condition?.type === "parenthesized_expression" ||
    (condition?.type === "binary_expression" && childForField(condition, "operator")?.text === "||")
  ) {
    condition = condition.parent;
  }
  const ifStatement = condition?.type === "condition_clause" ? condition.parent : undefined;
  if (ifStatement?.type !== "if_statement" || childForField(ifStatement, "alternative") !== undefined) {
    return undefined;
  }

  const consequence = childForField(ifStatement, "consequence");
  const lastStatement =
    consequence?.type === "compound_statement" ?
      consequence.namedChildren.filter((child) => child.type !== "comment").at(-1)
    : consequence;
  if (
    consequence === undefined ||
    (lastStatement?.type !== "continue_statement" && lastStatement?.type !== "return_statement")
  ) {
    return undefined;
  }

  const itemSegments = normalizePathSegments([...keyOwner.segments, MAP_KEY_SEGMENT]);
  const usesItem = consequence.descendantsOfType("identifier").some((identifier) => {
    const target = state.aliases.get(identifier.text);
    if (target?.location !== "body-root" || normalizePathSegments(target.segments) !== itemSegments) {
      return false;
    }
    // Naming the key, as in an error message, doesn't use the value.
    const access = identifier.parent;
    return !(access?.type === "field_expression" && childForField(access, "field")?.text === "key");
  });
  if (usesItem) {
    return undefined;
  }

  // `return false;` or `return Option<bool>(400, ...)`, as opposed to returning early on success.
  const returnsError =
    lastStatement.type === "return_statement" &&
    (lastStatement.namedChild(0)?.text === "false" || /\b4\d\d\b/.test(consequence.text));
  return returnsError ? "refused" : "skipped";
}

/** `if (x.count(k) == 0) { x[k] = default; }` fills in a default; it doesn't use what the client sent. */
function isDefaultFillCheck(
  lookupCall: SyntaxNode,
  methodName: string,
  baseNode: SyntaxNode,
  keyNode: SyntaxNode,
): boolean {
  const condition = outsideParentheses(lookupCall);
  const missing =
    methodName === "find" ?
      isComparisonWith(condition, "==", `${compactText(baseNode)}.end()`)
    : isComparisonWith(condition, "==", "0") ||
      (condition?.type === "unary_expression" && childForField(condition, "operator")?.text === "!");
  if (!missing || condition === undefined) {
    return false;
  }

  const conditionClause = outsideParentheses(condition);
  const ifStatement = conditionClause?.type === "condition_clause" ? conditionClause.parent : undefined;
  if (ifStatement?.type !== "if_statement" || childForField(ifStatement, "alternative") !== undefined) {
    return false;
  }

  const consequence = childForField(ifStatement, "consequence");
  const statements =
    consequence?.type === "compound_statement" ?
      consequence.namedChildren.filter((child) => child.type !== "comment")
    : [consequence];
  const fillTarget = `${compactText(baseNode)}[${compactText(keyNode)}]`;
  return statements.some((statement) => {
    const assignment = statement?.type === "expression_statement" ? statement.namedChild(0) : undefined;
    const target = assignment?.type === "assignment_expression" ? childForField(assignment, "left") : undefined;
    return target?.type === "subscript_expression" && compactText(target) === fillTarget;
  });
}

/** The nearest ancestor that isn't a pair of parentheses around this expression. */
function outsideParentheses(node: SyntaxNode): SyntaxNode | undefined {
  let parent = node.parent;
  while (parent?.type === "parenthesized_expression") {
    parent = parent.parent;
  }
  return parent ?? undefined;
}

/** `x OP value` or `value OP x`, where node is the comparison. */
function isComparisonWith(node: SyntaxNode | undefined, operator: string, value: string): boolean {
  if (node?.type !== "binary_expression" || childForField(node, "operator")?.text !== operator) {
    return false;
  }
  const left = childForField(node, "left");
  const right = childForField(node, "right");
  return (left !== undefined && compactText(left) === value) || (right !== undefined && compactText(right) === value);
}

function compactText(node: SyntaxNode): string {
  return node.text.replace(/\s+/g, "");
}

function collectHelperCallExpression(
  node: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  const callInfo = parseCallExpressionNode(node);
  if (callInfo === undefined) {
    return;
  }

  const lambda = callInfo.methodName === undefined ? state.lambdas.get(callInfo.calleeName) : undefined;
  if (lambda !== undefined) {
    collectLambdaCall(lambda, callInfo.arguments, state, context, visited, depth);
    return;
  }

  const helperDefinition = findCallDefinition(callInfo, context.functions, state);
  if (helperDefinition === undefined) {
    return;
  }

  const nextAliases = new Map<string, AliasTarget>();
  const boundStrings = new Map<string, string>();
  helperDefinition.parameters.forEach((parameter, parameterIndex) => {
    const argument = callInfo.arguments[parameterIndex];
    if (argument === undefined || parameter.name.length === 0) return;
    const boundString =
      isStringType(parameter.typeText) ? resolveStringTokenNode(argument, state.constants) : undefined;
    if (boundString !== undefined) {
      boundStrings.set(parameter.name, boundString);
    }
    const resolved = resolveExpressionNode(argument, state.aliases, state.constants);
    if (resolved === undefined || !canReceiveAlias(parameter.typeText, resolved)) return;
    nextAliases.set(parameter.name, resolved);
    state.debug(
      `helper arg ${helperDefinition.name}.${parameter.name} => ${resolved.location}:${normalizePathSegments(resolved.segments)}`,
    );
  });

  if (nextAliases.size === 0) {
    return;
  }

  analyzeFunction(
    helperDefinition,
    { ...context, aliasTargets: nextAliases, boundStrings },
    state.collector,
    visited,
    depth + 1,
    state.routeKey,
    state.debug,
  );
}

/** Follows a call to a local lambda with its parameters bound to the arguments. */
function collectLambdaCall(
  lambda: SyntaxNode,
  argumentsList: readonly SyntaxNode[],
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  const boundAliases = new Map<string, AliasTarget>();
  const boundStrings = new Map<string, string>();
  lambdaParameterNames(lambda).forEach((name, index) => {
    const argument = argumentsList[index];
    if (argument === undefined || name === undefined) return;
    const boundString = resolveStringTokenNode(argument, state.constants);
    if (boundString !== undefined) {
      boundStrings.set(name, boundString);
    }
    const resolved = resolveExpressionNode(argument, state.aliases, state.constants);
    if (resolved !== undefined) {
      boundAliases.set(name, resolved);
    }
  });

  if (boundAliases.size === 0 && boundStrings.size === 0) {
    return;
  }
  const visitKey = `lambda@${serializeVisitKey(
    `${state.definition.name}:${lambda.startIndex}`,
    boundAliases,
    boundStrings,
  )}`;
  if (visited.has(visitKey) || depth >= context.maxCallDepth) {
    return;
  }
  visited.add(visitKey);
  analyzeLambda(lambda, state, context, visited, depth + 1, boundAliases, boundStrings);
}

function analyzeLambda(
  lambda: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
  boundAliases: ReadonlyMap<string, AliasTarget>,
  boundStrings: ReadonlyMap<string, string>,
): void {
  const body = childForField(lambda, "body");
  if (body === undefined) {
    return;
  }

  const scopedState = cloneState(state);
  lambdaParameterNames(lambda).forEach((name) => {
    if (name === undefined) return;
    scopedState.declared.set(name, "");
    scopedState.aliases.delete(name);
    scopedState.constants.delete(name);
    scopedState.valueTypes.delete(name);
  });
  boundAliases.forEach((target, name) => scopedState.aliases.set(name, target));
  boundStrings.forEach((value, name) => scopedState.constants.set(name, value));
  analyzeBlock(body, scopedState, context, visited, depth);
}

/** Parameter names in order; undefined marks an unnamed parameter. */
function lambdaParameterNames(lambda: SyntaxNode): readonly (string | undefined)[] {
  const parameters = childForField(lambda, "declarator")
    ?.namedChildren.find((child) => child.type === "parameter_list")
    ?.namedChildren.filter((child) => child.type.endsWith("parameter_declaration"));
  return (parameters ?? []).map((parameter) => extractDeclaratorName(childForField(parameter, "declarator")));
}

function isConstDeclaration(declaration: SyntaxNode): boolean {
  return declaration.namedChildren.some(
    (child) => child.type === "type_qualifier" && (child.text === "const" || child.text === "constexpr"),
  );
}

/**
 * Whether a parameter of this type can receive the tracked value. Calls resolve
 * by name and arity, so this also rejects unrelated functions that collide, such
 * as CollectionManager::get_preset(name, preset) and the get_preset(req, res) handler.
 */
function canReceiveAlias(typeText: string, target: AliasTarget): boolean {
  if (typeText.includes("http_res")) {
    return false;
  }
  if (typeText.includes("http_req")) {
    return target.location === "request-root";
  }
  if (target.location === "request-root") {
    return false;
  }
  if (/\bmap\s*</.test(typeText)) {
    return (target.location === "params-root" || target.location === "query-root") && target.segments.length === 0;
  }
  return /json|iteration_proxy|\bauto\b/.test(typeText) || /^(?:const\s+)?[A-Z]$/.test(typeText.trim());
}

function isStringType(typeText: string): boolean {
  return typeText.includes("string") || typeText.includes("char");
}

function addParameter(
  target: AliasTarget,
  segments: readonly string[],
  state: AnalysisState,
  node: SyntaxNode,
  valueType?: TypePrimitives,
): void {
  const combinedSegments = [...target.segments, ...segments];

  if (
    target.location === "request-root" ||
    target.location === "param-entry" ||
    target.location === "param-key" ||
    target.location === "param-lookup" ||
    target.location === "body-key"
  ) {
    return;
  }

  // req->params holds path and query parameters alike, also when a helper
  // receives it as a plain map.
  if (target.location === "params-root" || target.location === "query-root") {
    const firstSegment = firstConcreteSegment(combinedSegments);
    if (firstSegment !== undefined) {
      const location = state.pathParamNames.has(firstSegment) ? "path" : "query";
      state.collector.add({
        location,
        // A URL path segment is a string, whatever the server converts it to.
        valueType: location === "path" ? "string" : valueType,
        canonicalPath: firstSegment,
        source: nodeSourceLocation(state.definition, node),
      });
      state.debug(`add ${location} ${firstSegment}`);
    }
    return;
  }

  const typedParameter = materializeTypedParameter(combinedSegments, valueType);
  if (typedParameter === undefined) {
    return;
  }

  state.collector.add({
    location: "body",
    canonicalPath: typedParameter.canonicalPath,
    valueType: typedParameter.valueType,
    source: nodeSourceLocation(state.definition, node),
  });
  state.debug(
    `add body ${typedParameter.canonicalPath}${
      typedParameter.valueType === undefined ? "" : ` : ${typedParameter.valueType}`
    }`,
  );
}

function findCallDefinition(
  callInfo: ParsedCall,
  functions: ReadonlyMap<string, FunctionDefinition>,
  state: AnalysisState,
): FunctionDefinition | undefined {
  // A method on a value we already track (json, params map), or on a local
  // declared as a std or nlohmann type, is a library call, even if the codebase
  // has an unrelated function with the same name.
  if (
    callInfo.baseNode !== undefined &&
    (resolveExpressionNode(callInfo.baseNode, state.aliases, state.constants) !== undefined ||
      isLibraryType(declaredType(state, callInfo.baseNode.text)))
  ) {
    return undefined;
  }

  const arity = callInfo.arguments.length;
  const calleeName = (callInfo.methodName ?? callInfo.calleeName)
    .replace(/<.*>/s, "")
    .replace(/\s+/g, "")
    .replace(/^::/, "");
  const receiverClass =
    callInfo.baseNode === undefined ? undefined : resolveReceiverClass(callInfo.baseNode, functions);
  const resolved =
    calleeName.includes("::") ?
      lookupFunction(calleeName, arity, functions)
    : ((receiverClass === undefined ? undefined : (
        lookupFunction(`${receiverClass}::${calleeName}`, arity, functions)
      )) ??
      lookupInCurrentClass(calleeName, arity, callInfo, functions, state) ??
      lookupFunction(calleeName, arity, functions));

  return resolved?.qualifiedName === state.definition.qualifiedName ? undefined : resolved;
}

const classNameIndexes = new WeakMap<ReadonlyMap<string, FunctionDefinition>, ReadonlyMap<string, string>>();

function normalizeClassName(name: string): string {
  return name.replaceAll("_", "").toLowerCase();
}

function classNameIndex(functions: ReadonlyMap<string, FunctionDefinition>): ReadonlyMap<string, string> {
  let index = classNameIndexes.get(functions);
  if (index === undefined) {
    const classNames = new Map<string, string>();
    for (const definition of functions.values()) {
      const scopeEnd = definition.qualifiedName.lastIndexOf("::");
      const className = scopeEnd < 0 ? "" : definition.qualifiedName.slice(0, scopeEnd).split("::").at(-1);
      if (className !== undefined && className.length > 0) {
        classNames.set(normalizeClassName(className), className);
      }
    }
    index = classNames;
    classNameIndexes.set(functions, index);
  }
  return index;
}

/**
 * The class of a method call's receiver, where its name says so:
 * `Foo::get_instance().bar()` is Foo, and `doc_analytics.bar()` is DocAnalytics.
 */
function resolveReceiverClass(
  baseNode: SyntaxNode,
  functions: ReadonlyMap<string, FunctionDefinition>,
): string | undefined {
  const receiver = unwrapExpressionNode(baseNode);
  if (receiver.type === "call_expression") {
    const callee = parseCallExpressionNode(receiver)?.calleeName ?? "";
    return callee.endsWith("::get_instance") ? callee.slice(0, -"::get_instance".length).split("::").at(-1) : undefined;
  }
  return receiver.type === "identifier" ? classNameIndex(functions).get(normalizeClassName(receiver.text)) : undefined;
}

/**
 * Prefers an exact arity. A call may also pass fewer arguments than the definition
 * has parameters, because default values are often only in the header.
 */
function lookupFunction(
  name: string,
  arity: number,
  functions: ReadonlyMap<string, FunctionDefinition>,
): FunctionDefinition | undefined {
  const exact = functions.get(`${name}#${arity}`);
  if (exact !== undefined) {
    return exact;
  }
  const candidate = functions.get(name);
  return candidate !== undefined && arity < candidate.parameters.length ? candidate : undefined;
}

/** An unqualified call inside `Foo::bar` means `Foo::baz` when that exists. */
function lookupInCurrentClass(
  calleeName: string,
  arity: number,
  callInfo: ParsedCall,
  functions: ReadonlyMap<string, FunctionDefinition>,
  state: AnalysisState,
): FunctionDefinition | undefined {
  if (callInfo.methodName !== undefined) {
    return undefined;
  }
  const scopeEnd = state.definition.qualifiedName.lastIndexOf("::");
  return scopeEnd < 0 ? undefined : (
      lookupFunction(`${state.definition.qualifiedName.slice(0, scopeEnd)}::${calleeName}`, arity, functions)
    );
}

function firstConcreteSegment(segments: readonly string[]): string | undefined {
  return segments.find((segment) => segment !== "[]" && segment.length > 0);
}

function nodeSourceLocation(definition: FunctionDefinition, node: SyntaxNode): SourceLocation {
  return {
    filePath: definition.filePath,
    line: definition.source.line + node.startPosition.row,
    column: node.startPosition.column + 1,
  };
}

function serializeVisitKey(
  functionName: string,
  aliases: ReadonlyMap<string, AliasTarget>,
  boundStrings: ReadonlyMap<string, string>,
): string {
  return [
    functionName,
    ...Array.from(aliases.entries()).map(
      ([aliasName, target]) => `${aliasName}:${target.location}:${normalizePathSegments(target.segments)}`,
    ),
    ...Array.from(boundStrings.entries()).map(([name, value]) => `${name}=${value}`),
  ].join("|");
}

/**
 * Applies an assignment to the current scope and every enclosing scope up to
 * the one that declared the variable, so `json j; if (...) { j = parse(...); }`
 * keeps the alias after the branch.
 */
function assignInScope(state: AnalysisState, name: string, apply: (scope: AnalysisState) => void): void {
  let scope: AnalysisState | undefined = state;
  while (scope !== undefined) {
    apply(scope);
    if (scope.declared.has(name)) {
      return;
    }
    scope = scope.parent;
  }
}

function declaredType(state: AnalysisState, name: string): string | undefined {
  for (let scope: AnalysisState | undefined = state; scope !== undefined; scope = scope.parent) {
    const typeText = scope.declared.get(name);
    if (typeText !== undefined) {
      return typeText;
    }
  }
  return undefined;
}

/** `std::set<std::string>`, `nlohmann::json`; not a smart pointer to a codebase class. */
function isLibraryType(typeText: string | undefined): boolean {
  return typeText !== undefined && /^(?:const\s+)?(?:std|nlohmann)::(?!shared_ptr|unique_ptr)/.test(typeText.trim());
}

function cloneState(state: AnalysisState): AnalysisState {
  return {
    aliases: new Map(state.aliases),
    constants: new Map(state.constants),
    valueTypes: new Map(state.valueTypes),
    parent: state,
    declared: new Map<string, string>(),
    lambdas: new Map(state.lambdas),
    keyTables: new Map(state.keyTables),
    definition: state.definition,
    collector: state.collector,
    pathParamNames: state.pathParamNames,
    routeKey: state.routeKey,
    debug: state.debug,
  };
}

function materializeTypedParameter(
  segments: readonly string[],
  valueType: TypePrimitives | undefined,
): { canonicalPath: string; valueType: ValueType | undefined } | undefined {
  if (segments.some((segment) => segment !== "[]" && segment.length === 0)) {
    return undefined;
  }

  const canonicalPath = normalizePathSegments(segments);
  if (canonicalPath.length === 0 || canonicalPath === MAP_KEY_SEGMENT) {
    return undefined;
  }

  if (canonicalPath.endsWith("[]")) {
    if (valueType === undefined) {
      return undefined;
    }

    const parentSegments = segments.slice(0, -1);
    const parentPath = normalizePathSegments(parentSegments);
    if (parentPath.length === 0) {
      return undefined;
    }

    const arrayType = `${valueType}[]`;
    if (!isValueType(arrayType)) {
      return undefined;
    }
    return { canonicalPath: parentPath, valueType: arrayType };
  }

  return { canonicalPath, valueType };
}

function extractTerminalName(value: string): string | undefined {
  const parts = value.split("::");
  return parts[parts.length - 1];
}

function isMethod(methodName: string): methodName is TypeMethodName {
  return methodName in typeMethods;
}

function isTemplate(callText: string): callText is TypeTemplateName {
  return callText in typeTemplates;
}

function inferTypeFromCall(
  normalizedMethodName: string,
  rawMethodName: string,
  baseNode: SyntaxNode | undefined,
): InferredValueType | undefined {
  if (isMethod(normalizedMethodName)) {
    return typeMethods[normalizedMethodName];
  }

  if (normalizedMethodName !== "get") {
    return undefined;
  }

  const templateType = inferTemplateType(rawMethodName);
  if (templateType !== undefined) {
    return templateType;
  }

  if (baseNode === undefined) {
    return undefined;
  }

  return inferTemplateType(baseNode.parent?.text ?? "");
}

function inferTemplateType(callText: string): InferredValueType | undefined {
  const typeStart = callText.indexOf("<");
  const typeEnd = callText.lastIndexOf(">");
  if (typeStart < 0 || typeEnd <= typeStart) {
    return undefined;
  }

  const templateText = callText.slice(typeStart + 1, typeEnd).replaceAll(" ", "");

  if (isTemplate(templateText)) {
    return typeTemplates[templateText];
  }
  return undefined;
}

function resolveValueTypeNode(node: SyntaxNode, state: AnalysisState): TypePrimitives | undefined {
  const normalizedNode = unwrapExpressionNode(node);
  if (normalizedNode.type === "string_literal") {
    return "string";
  }
  if (normalizedNode.type === "number_literal" || normalizedNode.type === "float_literal") {
    return normalizedNode.text.includes(".") ? "number" : "integer";
  }
  if (normalizedNode.text === "true" || normalizedNode.text === "false") {
    return "boolean";
  }
  if (normalizedNode.type === "identifier") {
    return state.valueTypes.get(normalizedNode.text);
  }

  const directTarget = resolveExpressionNode(normalizedNode, state.aliases, state.constants);
  if (directTarget?.location === "query-root" || directTarget?.location === "params-root") {
    return "string";
  }

  if (normalizedNode.type !== "call_expression") {
    return undefined;
  }

  const callInfo = parseCallExpressionNode(normalizedNode);
  if (callInfo === undefined) {
    return undefined;
  }

  if (callInfo.methodName !== undefined) {
    return inferTypeFromCall(normalizeMethodName(callInfo.methodName), callInfo.methodName, callInfo.baseNode);
  }

  const calleeName = extractTerminalName(callInfo.calleeName);
  if (callInfo.calleeName === "nlohmann::json::array" || calleeName === "array") {
    return "array";
  }
  if (callInfo.calleeName === "nlohmann::json::object" || calleeName === "object") {
    return "object";
  }
  if (calleeName === "stoul" || calleeName === "stoull") {
    return "uint";
  }
  if (calleeName === "stoi" || calleeName === "stoll") {
    return "integer";
  }
  if (calleeName === "stof" || calleeName === "stod") {
    return "number";
  }

  return undefined;
}

function normalizeMethodName(methodName: string): string {
  const templateStart = methodName.indexOf("<");
  return templateStart < 0 ? methodName : methodName.slice(0, templateStart);
}

function collectArgumentTypeHints(
  node: SyntaxNode,
  argumentsList: readonly SyntaxNode[],
  definition: FunctionDefinition,
  state: AnalysisState,
): void {
  definition.parameters.forEach((parameter, parameterIndex) => {
    const argument = argumentsList[parameterIndex];
    if (argument === undefined) return;

    const resolved = resolveExpressionNode(argument, state.aliases, state.constants);
    const inferredType = inferTypeFromParameter(parameter.typeText);
    if (resolved !== undefined && inferredType !== undefined) {
      addParameter(resolved, [], state, node, inferredType);
    }
  });
}

function inferTypeFromParameter(typeText: string): TypePrimitives | undefined {
  const normalized = typeText
    .replaceAll("&", "")
    .replaceAll("*", "")
    .replace(/\bconst\b/g, "")
    .replace(/\bstruct\b/g, "")
    .trim()
    .replaceAll(" ", "");

  if (isTemplate(normalized)) {
    return typeTemplates[normalized];
  }

  return undefined;
}

function inferWrappedAliasTarget(
  leftNode: SyntaxNode | undefined,
  rightTarget: AliasTarget | undefined,
  state: AnalysisState,
): { aliasName: string; target: AliasTarget } | undefined {
  if (leftNode === undefined || rightTarget === undefined) {
    return undefined;
  }

  if (leftNode.type !== "subscript_expression") {
    return undefined;
  }

  const baseNode = childForField(leftNode, "argument");
  const aliasName = baseNode === undefined ? undefined : extractIdentifierName(baseNode);
  // `req_json["name"] = req->params["name"]` copies a value into a variable that
  // already has a meaning; it does not turn req_json into the params map.
  if (aliasName !== undefined && state.aliases.has(aliasName)) {
    return undefined;
  }
  const indexNode = extractSubscriptIndexNode(leftNode);
  const segment = indexNode === undefined ? undefined : resolveStringTokenNode(indexNode, state.constants);
  if (
    aliasName === undefined ||
    segment === undefined ||
    rightTarget.segments.length === 0 ||
    rightTarget.segments[rightTarget.segments.length - 1] !== segment
  ) {
    return undefined;
  }

  return {
    aliasName,
    target: {
      location: rightTarget.location,
      segments: rightTarget.segments.slice(0, -1),
    },
  };
}
