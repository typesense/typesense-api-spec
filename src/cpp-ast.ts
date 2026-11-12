import Parser from "tree-sitter";
import type { SyntaxNode } from "tree-sitter";
import Cpp from "tree-sitter-cpp";

const parser = new Parser();
parser.setLanguage(Cpp as unknown as Parser.Language);

export function parseCpp(sourceText: string): SyntaxNode {
  return parser.parse(sourceText).rootNode;
}

const parsedFunctions = new Map<string, SyntaxNode>();

/** A function is analyzed once per route and alias combination; parse its text once. */
export function parseCppCached(sourceText: string): SyntaxNode {
  let rootNode = parsedFunctions.get(sourceText);
  if (rootNode === undefined) {
    rootNode = parseCpp(sourceText);
    parsedFunctions.set(sourceText, rootNode);
  }
  return rootNode;
}

export function findFirstNamedNode(rootNode: SyntaxNode, type: string): SyntaxNode | undefined {
  if (rootNode.type === type) {
    return rootNode;
  }

  return rootNode.namedChildren.find((child) => child.type === type) ?? undefined;
}

/** Depth-first walk. A visitor can return false to skip the node's children. */
export function walkNamed(node: SyntaxNode, visit: (node: SyntaxNode) => boolean | void): void {
  if (visit(node) === false) {
    return;
  }
  node.namedChildren.forEach((child) => walkNamed(child, visit));
}

export function childForField(node: SyntaxNode, fieldName: string): SyntaxNode | undefined {
  return node.childForFieldName(fieldName) ?? undefined;
}

export function extractStringLiteral(value: string): string | undefined {
  const trimmedValue = value.trim();
  if (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) {
    return trimmedValue.slice(1, trimmedValue.length - 1);
  }
  return undefined;
}

export function extractDeclaratorName(node: SyntaxNode | undefined): string | undefined {
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
