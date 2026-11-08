import { childForField, extractStringLiteral } from "../cpp-ast.js";
import { MAP_KEY_SEGMENT } from "../text.js";
import type { AliasTarget, FunctionParameter } from "../types.js";
import type { SyntaxNode } from "tree-sitter";
import {
  extractSubscriptIndexNode,
  parseCallExpressionNode,
  parseFieldExpression,
  unwrapExpressionNode,
} from "./syntax.js";

export function resolveExpressionNode(
  expressionNode: SyntaxNode,
  aliases: ReadonlyMap<string, AliasTarget>,
  constants: ReadonlyMap<string, string>,
): AliasTarget | undefined {
  const normalizedNode = unwrapExpressionNode(expressionNode);

  const requestRoot = resolveRequestRoot(normalizedNode, aliases);
  if (requestRoot !== undefined) return requestRoot;

  const entryKey = resolveEntryKey(normalizedNode, aliases);
  if (entryKey !== undefined) return entryKey;

  const lookupValue = resolveLookupValue(normalizedNode, aliases);
  if (lookupValue !== undefined) return lookupValue;

  const directAlias = getDirectAlias(normalizedNode, aliases);
  if (directAlias !== undefined) return directAlias;

  if (isRequestIdentifier(normalizedNode, aliases)) {
    return { location: "request-root", segments: [] };
  }

  if (normalizedNode.type === "call_expression") {
    return resolveCallExpression(normalizedNode, aliases, constants);
  }

  if (normalizedNode.type === "subscript_expression") {
    return resolveSubscriptExpression(normalizedNode, aliases, constants);
  }

  return undefined;
}

function resolveEntryKey(node: SyntaxNode, aliases: ReadonlyMap<string, AliasTarget>): AliasTarget | undefined {
  const fieldParts = parseFieldExpression(node);
  if (fieldParts?.fieldName !== "first" || fieldParts.baseNode.type !== "identifier") {
    return undefined;
  }
  return aliases.get(fieldParts.baseNode.text)?.location === "param-entry" ?
      { location: "param-key", segments: [] }
    : undefined;
}

/** `it->second`, where `it = params.find("x")`, is the value of parameter x. */
function resolveLookupValue(node: SyntaxNode, aliases: ReadonlyMap<string, AliasTarget>): AliasTarget | undefined {
  const fieldParts = parseFieldExpression(node);
  if (fieldParts?.fieldName !== "second" || fieldParts.baseNode.type !== "identifier") {
    return undefined;
  }
  const iterator = aliases.get(fieldParts.baseNode.text);
  return iterator?.location === "param-lookup" ? { location: "params-root", segments: iterator.segments } : undefined;
}

function getDirectAlias(node: SyntaxNode, aliases: ReadonlyMap<string, AliasTarget>): AliasTarget | undefined {
  if (node.type !== "identifier") {
    return undefined;
  }
  return aliases.get(node.text);
}

function resolveCallExpression(
  node: SyntaxNode,
  aliases: ReadonlyMap<string, AliasTarget>,
  constants: ReadonlyMap<string, string>,
): AliasTarget | undefined {
  const callInfo = parseCallExpressionNode(node);
  if (callInfo === undefined) {
    return undefined;
  }

  if (callInfo.methodName === undefined) {
    return resolveFreeCallExpression(callInfo, aliases, constants);
  }

  return resolveMethodCallExpression(callInfo, aliases, constants);
}

function resolveFreeCallExpression(
  callInfo: NonNullable<ReturnType<typeof parseCallExpressionNode>>,
  aliases: ReadonlyMap<string, AliasTarget>,
  constants: ReadonlyMap<string, string>,
): AliasTarget | undefined {
  const calleeName = extractTerminalName(callInfo.calleeName);
  const isJsonParseCall = callInfo.calleeName === "nlohmann::json::parse" || calleeName === "parse";
  if (!isJsonParseCall) {
    return undefined;
  }

  const firstArgument = callInfo.arguments[0];
  if (firstArgument === undefined) {
    return undefined;
  }

  const firstTarget = resolveExpressionNode(firstArgument, aliases, constants);
  if (firstTarget?.location !== "body-root") {
    return undefined;
  }

  return { location: "body-root", segments: [] };
}

function resolveMethodCallExpression(
  callInfo: NonNullable<ReturnType<typeof parseCallExpressionNode>>,
  aliases: ReadonlyMap<string, AliasTarget>,
  constants: ReadonlyMap<string, string>,
): AliasTarget | undefined {
  if (callInfo.baseNode === undefined) {
    return undefined;
  }

  const baseTarget = resolveExpressionNode(callInfo.baseNode, aliases, constants);
  if (baseTarget === undefined) {
    return undefined;
  }

  if (callInfo.methodName === "items") {
    return baseTarget;
  }

  // `x.get<nlohmann::json>()` is still x.
  if (/^get\s*<.*json.*>$/s.test(callInfo.methodName ?? "")) {
    return baseTarget;
  }

  if (callInfo.methodName === "value") {
    if (callInfo.arguments.length === 0) {
      return baseTarget;
    }
    return resolveIndexedMethodTarget(baseTarget, callInfo.arguments[0], constants);
  }

  if (callInfo.methodName === "find" || callInfo.methodName === "at") {
    return resolveIndexedMethodTarget(baseTarget, callInfo.arguments[0], constants);
  }

  return undefined;
}

function resolveIndexedMethodTarget(
  baseTarget: AliasTarget,
  firstArgument: SyntaxNode | undefined,
  constants: ReadonlyMap<string, string>,
): AliasTarget | undefined {
  if (firstArgument === undefined) {
    return undefined;
  }

  const segment = resolveStringTokenNode(firstArgument, constants);
  if (segment === undefined) {
    return undefined;
  }

  return {
    location: baseTarget.location,
    segments: [...baseTarget.segments, segment],
  };
}

function resolveSubscriptExpression(
  node: SyntaxNode,
  aliases: ReadonlyMap<string, AliasTarget>,
  constants: ReadonlyMap<string, string>,
): AliasTarget | undefined {
  const baseNode = childForField(node, "argument");
  const indexNode = extractSubscriptIndexNode(node);
  if (baseNode === undefined || indexNode === undefined) {
    return undefined;
  }

  const baseTarget = resolveExpressionNode(baseNode, aliases, constants);
  if (baseTarget === undefined) {
    return undefined;
  }

  const segment = resolveStringTokenNode(indexNode, constants) ?? "[]";
  return {
    location: baseTarget.location,
    segments: [...baseTarget.segments, segment],
  };
}

function extractTerminalName(value: string): string | undefined {
  const parts = value.split("::");
  return parts[parts.length - 1];
}

export function resolveLoopItemTarget(
  expressionNode: SyntaxNode,
  aliases: ReadonlyMap<string, AliasTarget>,
  constants: ReadonlyMap<string, string>,
): AliasTarget | undefined {
  const resolved = resolveExpressionNode(expressionNode, aliases, constants);
  // Iterating req->params or a query map yields key/value pairs, not
  // addressable fields; only JSON body arrays/objects produce item aliases.
  if (resolved?.location === "params-root" || resolved?.location === "query-root") {
    return resolved.segments.length === 0 ? { location: "param-entry", segments: [] } : undefined;
  }
  if (resolved === undefined || resolved.location !== "body-root") {
    return undefined;
  }

  // `.items()` iterates an object's keys; plain iteration walks an array.
  const iterable = unwrapExpressionNode(expressionNode);
  const isItemsCall = iterable.type === "call_expression" && parseCallExpressionNode(iterable)?.methodName === "items";
  return {
    location: resolved.location,
    segments: [...resolved.segments, isItemsCall ? MAP_KEY_SEGMENT : "[]"],
  };
}

export function resolveStringTokenNode(node: SyntaxNode, constants: ReadonlyMap<string, string>): string | undefined {
  // Check qualified names before unwrapping: unwrapExpressionNode reduces
  // `fields::type` to its terminal identifier `type`.
  const qualifiedNode = unwrapParentheses(node);
  if (qualifiedNode.type === "qualified_identifier") {
    return resolveQualifiedIdentifierToken(qualifiedNode.text, constants);
  }

  const normalizedNode = unwrapExpressionNode(node);
  if (normalizedNode.type === "string_literal") {
    return extractStringLiteral(normalizedNode.text);
  }

  if (normalizedNode.type === "concatenated_string") {
    return resolveConcatenatedString(normalizedNode);
  }

  if (normalizedNode.type === "identifier") {
    return constants.get(normalizedNode.text);
  }

  return undefined;
}

function unwrapParentheses(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.type === "parenthesized_expression" && current.namedChildren[0] !== undefined) {
    current = current.namedChildren[0];
  }
  return current;
}

function resolveConcatenatedString(node: SyntaxNode): string | undefined {
  return node.namedChildren.reduce<string | undefined>((combined, child) => {
    if (combined === undefined || child.type !== "string_literal") {
      return undefined;
    }

    const value = extractStringLiteral(child.text);
    if (value === undefined) {
      return undefined;
    }

    return `${combined}${value}`;
  }, "");
}

function resolveQualifiedIdentifierToken(
  tokenText: string,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  const qualifiedName = tokenText.replace(/\s+/g, "").replace(/^::/, "");
  const qualifiedValue = constants.get(qualifiedName);
  if (qualifiedValue !== undefined) {
    return qualifiedValue;
  }

  if (qualifiedName.startsWith("fields::")) {
    return qualifiedName.slice("fields::".length);
  }

  const terminalName = extractTerminalName(tokenText);
  if (terminalName === undefined) {
    return undefined;
  }

  return constants.get(terminalName);
}

export function bootstrapAliases(
  parameters: readonly FunctionParameter[],
  inherited: ReadonlyMap<string, AliasTarget>,
): Map<string, AliasTarget> {
  const aliases = new Map(inherited);

  parameters
    .filter((parameter) => parameter.name.length > 0 && parameter.typeText.includes("http_req"))
    .forEach((parameter) => aliases.set(parameter.name, { location: "request-root", segments: [] }));

  return aliases;
}

function resolveRequestRoot(node: SyntaxNode, aliases: ReadonlyMap<string, AliasTarget>): AliasTarget | undefined {
  const fieldParts = parseFieldExpression(node);
  if (fieldParts === undefined) {
    return undefined;
  }

  if (fieldParts.operator !== "->" || !isRequestIdentifier(fieldParts.baseNode, aliases)) {
    return undefined;
  }

  if (fieldParts.fieldName === "params") {
    return { location: "params-root", segments: [] };
  }

  if (fieldParts.fieldName === "body") {
    return { location: "body-root", segments: [] };
  }

  return undefined;
}

function isRequestIdentifier(node: SyntaxNode, aliases: ReadonlyMap<string, AliasTarget>): boolean {
  return node.type === "identifier" && aliases.get(node.text)?.location === "request-root";
}
