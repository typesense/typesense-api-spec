import { childForField } from "../cpp-ast.js";
import type { AliasTarget, FunctionParameter } from "../types.js";
import type { SyntaxNode } from "tree-sitter";
import {
  extractStringLiteral,
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

  const requestRoot = resolveRequestRoot(normalizedNode);
  if (requestRoot !== undefined) return requestRoot;

  const directAlias = getDirectAlias(normalizedNode, aliases);
  if (directAlias !== undefined) return directAlias;

  if (normalizedNode.type === "call_expression") {
    return resolveCallExpression(normalizedNode, aliases, constants);
  }

  if (normalizedNode.type === "subscript_expression") {
    return resolveSubscriptExpression(normalizedNode, aliases, constants);
  }

  return undefined;
}

function getDirectAlias(
  node: SyntaxNode,
  aliases: ReadonlyMap<string, AliasTarget>,
): AliasTarget | undefined {
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
  const isJsonParseCall =
    callInfo.calleeName === "nlohmann::json::parse" || calleeName === "parse";
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

  const baseTarget = resolveExpressionNode(
    callInfo.baseNode,
    aliases,
    constants,
  );
  if (baseTarget === undefined) {
    return undefined;
  }

  if (callInfo.methodName === "items") {
    return baseTarget;
  }

  if (callInfo.methodName === "value") {
    if (callInfo.arguments.length === 0) {
      return baseTarget;
    }
    return resolveIndexedMethodTarget(
      baseTarget,
      callInfo.arguments[0],
      constants,
    );
  }

  if (callInfo.methodName === "find" || callInfo.methodName === "at") {
    return resolveIndexedMethodTarget(
      baseTarget,
      callInfo.arguments[0],
      constants,
    );
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
  if (resolved === undefined || resolved.location === "query-root") {
    return undefined;
  }

  return {
    location: "body-root",
    segments: [...resolved.segments, "[]"],
  };
}

export function resolveStringTokenNode(
  node: SyntaxNode,
  constants: ReadonlyMap<string, string>,
): string | undefined {
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

  if (normalizedNode.type === "qualified_identifier") {
    return resolveQualifiedIdentifierToken(normalizedNode.text, constants);
  }

  return undefined;
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
  if (tokenText.startsWith("fields::")) {
    return tokenText.slice("fields::".length);
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
    .filter((parameter) =>
      parameter.typeText.includes("std::map<std::string, std::string>"),
    )
    .forEach((parameter) =>
      aliases.set(parameter.name, { location: "query-root", segments: [] }),
    );

  return aliases;
}

function resolveRequestRoot(node: SyntaxNode): AliasTarget | undefined {
  const fieldParts = parseFieldExpression(node);
  if (fieldParts === undefined) {
    return undefined;
  }

  if (
    fieldParts.operator !== "->" ||
    fieldParts.baseNode.type !== "identifier" ||
    fieldParts.baseNode.text !== "req"
  ) {
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
