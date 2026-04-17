import Parser from "tree-sitter";
import type { SyntaxNode } from "tree-sitter";
import Cpp from "tree-sitter-cpp";

const parser = new Parser();
parser.setLanguage(Cpp as unknown as Parser.Language);

export function parseCpp(sourceText: string): SyntaxNode {
  return parser.parse(sourceText).rootNode;
}

export function findFirstNamedNode(rootNode: SyntaxNode, type: string): SyntaxNode | undefined {
  if (rootNode.type === type) {
    return rootNode;
  }

  return rootNode.namedChildren.find((child) => child.type === type) ?? undefined;
}

export function walkNamed(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  node.namedChildren.forEach((child) => walkNamed(child, visit));
}

export function childForField(node: SyntaxNode, fieldName: string): SyntaxNode | undefined {
  return node.childForFieldName(fieldName) ?? undefined;
}
