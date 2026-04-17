import { parseCpp, findFirstNamedNode, walkNamed, childForField } from "../cpp-ast.js";
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
  extractDeclaratorName,
  extractIdentifierName,
  extractLoopAliasName,
  extractSubscriptIndexNode,
  isConstantIdentifier,
  parseCallExpressionNode,
} from "./syntax.js";

const bodyMethods = new Set(["count", "find", "contains", "at"]);

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
  const inheritedAliases = bootstrapAliases(definition.parameters, context.aliasTargets);
  const visitKey = serializeVisitKey(definition.name, inheritedAliases);
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

  const rootNode = parseCpp(definition.fullText);
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

  const state: AnalysisState = {
    aliases: inheritedAliases,
    constants: new Map(context.constants),
    valueTypes: new Map<string, TypePrimitives>(),
    definition,
    collector,
    pathParamNames: context.pathParamNames,
    routeKey,
    debug,
  };

  state.debug(`analyzing ${definition.name}`);
  analyzeBlock(bodyNode, state, context, visited, depth);
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

  if (statement.type === "if_statement" || statement.type === "while_statement") {
    statement.namedChildren.forEach((child) => {
      if (child.type === "compound_statement") {
        analyzeBlock(child, cloneState(state), context, visited, depth);
      } else {
        walkExpression(child, state, context, visited, depth);
      }
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
  walkNamed(statement, (child) => {
    if (child === statement || child.type !== "init_declarator") {
      return;
    }

    const declaratorNode = childForField(child, "declarator");
    const valueNode = childForField(child, "value");
    const aliasName = extractDeclaratorName(declaratorNode);
    if (aliasName === undefined || valueNode === undefined) {
      return;
    }

    const literalValue = resolveStringTokenNode(valueNode, state.constants);
    if (literalValue !== undefined && isConstantIdentifier(aliasName)) {
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
    analyzeBlock(bodyNode, cloneState(state), context, visited, depth);
    return;
  }

  const scopedState = cloneState(state);
  const resolved = resolveLoopItemTarget(iterableNode, scopedState.aliases, scopedState.constants);
  if (resolved !== undefined) {
    scopedState.aliases.set(aliasName, resolved);
    state.debug(`loop ${aliasName} => ${resolved.location}:${normalizePathSegments(resolved.segments)}`);
  }

  analyzeBlock(bodyNode, scopedState, context, visited, depth);
}

function handleForLoop(
  statement: SyntaxNode,
  state: AnalysisState,
  context: ExtractionContext,
  visited: Set<string>,
  depth: number,
): void {
  for (const child of statement.namedChildren) {
    if (child.type === "compound_statement") {
      analyzeBlock(child, cloneState(state), context, visited, depth);
      continue;
    }

    walkExpression(child, state, context, visited, depth);
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
    if (currentNode.type === "assignment_expression") {
      collectAssignmentExpression(currentNode, state);
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
      state.aliases.set(aliasName, resolved);
      state.debug(`assign ${aliasName} => ${resolved.location}:${normalizePathSegments(resolved.segments)}`);
    }
    if (inferredType !== undefined) {
      state.valueTypes.set(aliasName, inferredType);
    }
  }

  const rightTarget = resolveExpressionNode(rightNode, state.aliases, state.constants);
  const wrappedAlias = inferWrappedAliasTarget(leftNode, rightTarget, state);
  if (wrappedAlias !== undefined) {
    state.aliases.set(wrappedAlias.aliasName, wrappedAlias.target);
    state.debug(
      `assign ${wrappedAlias.aliasName} => ${wrappedAlias.target.location}:${normalizePathSegments(wrappedAlias.target.segments)}`,
    );
  }

  const target = leftNode === undefined ? undefined : resolveExpressionNode(leftNode, state.aliases, state.constants);
  if (target !== undefined && target.location === "body-root") {
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
          addParameter(resolved, [segment], state, node);
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

  const helperDefinition = findCallDefinition(callInfo, context.functions, state.definition.name);
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

  const helperDefinition = findCallDefinition(callInfo, context.functions, state.definition.name);
  if (helperDefinition === undefined) {
    return;
  }

  const nextAliases = new Map<string, AliasTarget>();
  helperDefinition.parameters.forEach((parameter, parameterIndex) => {
    const argument = callInfo.arguments[parameterIndex];
    if (argument === undefined) return;
    const resolved = resolveExpressionNode(argument, state.aliases, state.constants);
    if (resolved === undefined) return;
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
    { ...context, aliasTargets: nextAliases, constants: state.constants },
    state.collector,
    visited,
    depth + 1,
    state.routeKey,
    state.debug,
  );
}

function addParameter(
  target: AliasTarget,
  segments: readonly string[],
  state: AnalysisState,
  node: SyntaxNode,
  valueType?: TypePrimitives,
): void {
  const combinedSegments = [...target.segments, ...segments];

  if (target.location === "query-root") {
    const firstSegment = firstConcreteSegment(combinedSegments);
    if (firstSegment !== undefined) {
      state.collector.add({
        location: "query",
        canonicalPath: firstSegment,
        valueType: valueType ?? "string",
        source: nodeSourceLocation(state.definition, node),
      });
      state.debug(`add query ${firstSegment}`);
    }
    return;
  }

  if (target.location === "params-root") {
    const firstSegment = firstConcreteSegment(combinedSegments);
    if (firstSegment !== undefined) {
      const location = state.pathParamNames.has(firstSegment) ? "path" : "query";
      state.collector.add({
        location,
        canonicalPath: firstSegment,
        valueType: valueType ?? "string",
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
  callInfo: ReturnType<typeof parseCallExpressionNode>,
  functions: ReadonlyMap<string, FunctionDefinition>,
  currentFunctionName: string,
): FunctionDefinition | undefined {
  if (callInfo === undefined) {
    return undefined;
  }

  const calleeKey = callInfo.methodName === undefined ? callInfo.calleeName : normalizeMethodName(callInfo.methodName);
  const helper = functions.get(calleeKey);
  const normalizedCalleeName = extractTerminalName(calleeKey);
  const normalizedCurrentName = extractTerminalName(currentFunctionName);
  const arityKey =
    normalizedCalleeName === undefined ? undefined : `${normalizedCalleeName}#${callInfo.arguments.length}`;
  const resolvedHelper =
    (arityKey === undefined ? undefined : functions.get(arityKey)) ??
    helper ??
    (normalizedCalleeName === undefined ? undefined : functions.get(normalizedCalleeName));
  if (resolvedHelper === undefined || resolvedHelper.name === normalizedCurrentName) {
    return undefined;
  }

  return resolvedHelper;
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

function serializeVisitKey(functionName: string, aliases: ReadonlyMap<string, AliasTarget>): string {
  return [
    functionName,
    ...Array.from(aliases.entries()).map(
      ([aliasName, target]) => `${aliasName}:${target.location}:${normalizePathSegments(target.segments)}`,
    ),
  ].join("|");
}

function cloneState(state: AnalysisState): AnalysisState {
  return {
    aliases: new Map(state.aliases),
    constants: new Map(state.constants),
    valueTypes: new Map(state.valueTypes),
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
  const normalizedNode = unwrapTypeNode(node);
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

function unwrapTypeNode(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (
    (current.type === "parenthesized_expression" ||
      current.type === "reference_expression" ||
      current.type === "qualified_identifier") &&
    current.namedChildren.length > 0
  ) {
    current = current.namedChildren[current.namedChildren.length - 1] ?? current;
  }
  return current;
}
