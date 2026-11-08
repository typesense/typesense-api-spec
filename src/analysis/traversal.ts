import { parseCppCached, findFirstNamedNode, walkNamed, childForField, extractDeclaratorName } from "../cpp-ast.js";
import { normalizePathSegments } from "../text.js";
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
} as const satisfies Record<string, TypePrimitives>;

type TypeTemplateName = keyof typeof typeTemplates;
type TypeMethodName = keyof typeof typeMethods;
type InferredValueType = (typeof typeMethods)[TypeMethodName] | (typeof typeTemplates)[TypeTemplateName];

interface AnalysisState {
  readonly aliases: Map<string, AliasTarget>;
  readonly constants: Map<string, string>;
  readonly valueTypes: Map<string, TypePrimitives>;
  /** Enclosing scope; assignments propagate to it unless the name is declared here. */
  readonly parent: AnalysisState | undefined;
  /** Variable names declared in this scope (they shadow outer ones). */
  readonly declared: Set<string>;
  /** Lambdas assigned to local variables, followed when they are called. */
  readonly lambdas: Map<string, SyntaxNode>;
  readonly definition: FunctionDefinition; readonly collector: ParameterCollector;
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
  const inheritedAliases = depth === 0 ? bootstrapAliases(definition.parameters, context.aliasTargets) : new Map(context.aliasTargets);
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
    declared: new Set<string>(),
    lambdas: new Map<string, SyntaxNode>(),
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
    const compoundChildren = statement.namedChildren.filter((child) => child.type === "compound_statement");
    const [firstChild, ...restChildren] = compoundChildren;
    if (firstChild !== undefined) {
      analyzeBlock(firstChild, state, context, visited, depth);
    }
    restChildren.forEach((child) => {
      analyzeBlock(child, cloneState(state), context, visited, depth);
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
  statement.childrenForFieldName("declarator").forEach((declarator) => {
    const declaredName = extractDeclaratorName(declarator);
    if (declaredName !== undefined) {
      state.declared.add(declaredName);
      // A new variable shadows any alias or constant from an outer scope.
      state.aliases.delete(declaredName);
      state.constants.delete(declaredName);
      state.valueTypes.delete(declaredName);
    }
  });

  walkNamed(statement, (child) => {
    if (child.type === "lambda_expression") {
      return false;
    }

    // `auto x = ...;` nests an init_declarator; a condition such as
    // `if (auto x = ...)` puts declarator/value directly on the declaration.
    const isConditionDeclaration =
      child.type === "declaration" && childForField(child, "value") !== undefined;
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

  const aliasName = extractLoopAliasName(statement);
  if (aliasName === undefined) {
    analyzeStatement(bodyNode, cloneState(state), context, visited, depth);
    return;
  }

  const scopedState = cloneState(state);
  scopedState.declared.add(aliasName);
  scopedState.constants.delete(aliasName);
  const resolved = resolveLoopItemTarget(iterableNode, scopedState.aliases, scopedState.constants);
  if (resolved !== undefined) {
    scopedState.aliases.set(aliasName, resolved);
    state.debug(`loop ${aliasName} => ${resolved.location}:${normalizePathSegments(resolved.segments)}`);
  }

  analyzeStatement(bodyNode, scopedState, context, visited, depth);
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

function collectAssignmentExpression(node: SyntaxNode, state: AnalysisState): void {
  const leftNode = childForField(node, "left");
  const rightNode = childForField(node, "right");
  if (rightNode === undefined) {
    return;
  }

  const inferredType = resolveValueTypeNode(rightNode, state);
  const aliasName = leftNode === undefined ? undefined : extractIdentifierName(leftNode);
  if (aliasName !== undefined) {
    const resolved = resolveExpressionNode(rightNode, state.aliases, state.constants);
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

function collectCallExpression(node: SyntaxNode, state: AnalysisState, context: ExtractionContext): void {
  const callInfo = parseCallExpressionNode(node);
  if (callInfo === undefined) {
    return;
  }

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
      if (firstArgument !== undefined) {
        const segment = resolveStringTokenNode(firstArgument, state.constants);
        if (segment !== undefined) {
          state.debug(`call ${callInfo.calleeName} => ${segment}`);
          // nlohmann `.value(key, default)`: the default value's type is the field's type.
          const defaultArgument = normalizedMethodName === "value" ? callInfo.arguments[1] : undefined;
          const valueType =
            defaultArgument === undefined ? undefined : resolveValueTypeNode(defaultArgument, state);
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

  const leftTarget = resolveExpressionNode(leftNode, state.aliases, state.constants);
  const rightTarget = resolveExpressionNode(rightNode, state.aliases, state.constants);
  const leftType = resolveValueTypeNode(rightNode, state);
  const rightType = resolveValueTypeNode(leftNode, state);

  if (leftTarget !== undefined && leftType !== undefined) {
    addParameter(leftTarget, [], state, node, leftType);
  }
  if (rightTarget !== undefined && rightType !== undefined) {
    addParameter(rightTarget, [], state, node, rightType);
  }
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
    const boundString = isStringType(parameter.typeText) ? resolveStringTokenNode(argument, state.constants) : undefined;
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
    scopedState.declared.add(name);
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

  if (target.location === "request-root") {
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
  // A method on a value we already track (json, params map) is a library call,
  // even if the codebase has an unrelated function with the same name.
  if (
    callInfo.baseNode !== undefined &&
    resolveExpressionNode(callInfo.baseNode, state.aliases, state.constants) !== undefined
  ) {
    return undefined;
  }

  const arity = callInfo.arguments.length;
  const calleeName = (callInfo.methodName ?? callInfo.calleeName).replace(/<.*>/s, "").replace(/\s+/g, "");
  const resolved =
    calleeName.includes("::") ?
      functions.get(`${calleeName.replace(/^::/, "")}#${arity}`)
    : lookupInCurrentClass(calleeName, arity, callInfo, functions, state) ?? functions.get(`${calleeName}#${arity}`);

  return resolved?.qualifiedName === state.definition.qualifiedName ? undefined : resolved;
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
  return scopeEnd < 0 ?
      undefined
    : functions.get(`${state.definition.qualifiedName.slice(0, scopeEnd)}::${calleeName}#${arity}`);
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

function cloneState(state: AnalysisState): AnalysisState {
  return {
    aliases: new Map(state.aliases),
    constants: new Map(state.constants),
    valueTypes: new Map(state.valueTypes),
    parent: state,
    declared: new Set<string>(),
    lambdas: new Map(state.lambdas),
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
  if (canonicalPath.length === 0) {
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
