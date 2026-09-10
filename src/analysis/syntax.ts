import { childForField } from "../cpp-ast.js";
import type { SyntaxNode } from "tree-sitter";

export interface ParsedCall {
  readonly calleeName: string;
  readonly baseNode: SyntaxNode | undefined;
  readonly methodName: string | undefined;
  readonly arguments: readonly SyntaxNode[];
}

export function parseCallExpressionNode(
  node: SyntaxNode,
): ParsedCall | undefined {
  const functionNode = childForField(node, "function");
  const argumentListNode = node.namedChildren.find(
    (child) => child.type === "argument_list",
  );
  if (functionNode === undefined || argumentListNode === undefined) {
    return undefined;
  }

  const argumentsList = [...argumentListNode.namedChildren];
  const fieldParts =
    functionNode.type === "field_expression"
      ? parseFieldExpression(functionNode)
      : undefined;
  if (fieldParts !== undefined) {
    return {
      calleeName: functionNode.text,
      baseNode: fieldParts.baseNode,
      methodName: fieldParts.fieldName,
      arguments: argumentsList,
    };
  }

  return {
    calleeName: functionNode.text,
    baseNode: undefined,
    methodName: undefined,
    arguments: argumentsList,
  };
}

export function extractStringLiteral(value: string): string | undefined {
  const trimmedValue = value.trim();
  if (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) {
    return trimmedValue.slice(1, trimmedValue.length - 1);
  }
  return undefined;
}

export function parseFieldExpression(node: SyntaxNode):
  | {
      readonly baseNode: SyntaxNode;
      readonly fieldName: string;
      readonly operator: string;
    }
  | undefined {
  if (node.type !== "field_expression") {
    return undefined;
  }

  const baseNode = childForField(node, "argument");
  const fieldNode = childForField(node, "field");
  const operatorNode = childForField(node, "operator");
  if (
    baseNode === undefined ||
    fieldNode === undefined ||
    operatorNode === undefined
  ) {
    return undefined;
  }

  return {
    baseNode,
    fieldName: fieldNode.text,
    operator: operatorNode.text,
  };
}

export function extractLoopAliasName(statement: SyntaxNode): string | undefined {
  return statement.namedChildren
    .filter((child) => child.type !== "compound_statement" && child.type !== "field_expression")
    .map((child) => extractDeclaratorName(child))
    .find((name): name is string => name !== undefined);
}

export function extractSubscriptIndexNode(
  node: SyntaxNode,
): SyntaxNode | undefined {
  const argListNode = node.namedChildren.find(
    (child) => child.type === "subscript_argument_list",
  );
  return argListNode?.namedChildren[0];
}

export function extractIdentifierName(node: SyntaxNode): string | undefined {
  const normalizedNode = unwrapExpressionNode(node);
  if (normalizedNode.type === "identifier") {
    return normalizedNode.text;
  }
  return undefined;
}

export function extractDeclaratorName(
  node: SyntaxNode | undefined,
): string | undefined {
  if (node === undefined) {
    return undefined;
  }

  if (node.type === "identifier" || node.type === "field_identifier") {
    return node.text;
  }

  const nestedDeclarator = childForField(node, "declarator");
  if (nestedDeclarator !== undefined) {
    return extractDeclaratorName(nestedDeclarator);
  }

  for (const child of node.namedChildren) {
    const name = extractDeclaratorName(child);
    if (name !== undefined) {
      return name;
    }
  }

  return undefined;
}

export function unwrapExpressionNode(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (
    (current.type === "parenthesized_expression" ||
      current.type === "reference_expression" ||
      current.type === "qualified_identifier") &&
    current.namedChildren.length > 0
  ) {
    current =
      current.namedChildren[current.namedChildren.length - 1] ?? current;
  }
  return current;
}

export function isConstantIdentifier(value: string): boolean {
  return value.length > 0 && /^[A-Z0-9_]+$/.test(value);
}
