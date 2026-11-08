import { describe, expect, test } from "bun:test";
import { extractPathName, normalizePathSegments, removeUnbalancedConditionals } from "../src/text.js";

describe("removeUnbalancedConditionals", () => {
  const lineCount = (text: string): number => text.split("\n").length;

  test("leaves balanced conditionals alone", () => {
    const source = "#ifdef A\nvoid f() {}\n#else\nvoid g() {}\n#endif\n";
    expect(removeUnbalancedConditionals(source)).toBe(source);
  });

  test("removes an #ifdef branch that opens a brace, keeping line numbers", () => {
    const source = "a();\n#ifdef A\nif (x) {\n#endif\nb();";
    const result = removeUnbalancedConditionals(source);
    expect(result).toBe("a();\n\n\n\nb();");
    expect(lineCount(result)).toBe(lineCount(source));
  });

  test("keeps the #else branch of an unbalanced #ifdef", () => {
    expect(removeUnbalancedConditionals("#ifdef A\nif (x) {\n#else\nif (y) {\n#endif\n}")).toBe("\n\n\nif (y) {\n\n}");
  });

  test("keeps the first branch of an unbalanced #ifndef", () => {
    expect(removeUnbalancedConditionals("#ifndef A\nif (x) {\n#else\nif (y) {\n#endif\n}")).toBe("\nif (x) {\n\n\n\n}");
  });

  test("handles a nested conditional", () => {
    const result = removeUnbalancedConditionals("#ifdef A\n#ifdef B\nif (x) {\n#endif\nkept();\n#endif");
    expect(result).toBe("#ifdef A\n\n\n\nkept();\n#endif");
  });

  test("ignores braces in strings, characters and comments", () => {
    const source = "#ifdef A\nlog(\"{\"); char c = '{'; // {\n#endif";
    expect(removeUnbalancedConditionals(source)).toBe(source);
  });

  test("tolerates an #endif with no opening directive", () => {
    expect(removeUnbalancedConditionals("#endif\na();")).toBe("#endif\na();");
  });
});

describe("path helpers", () => {
  test("normalizePathSegments joins fields with dots and arrays without", () => {
    expect(normalizePathSegments(["fields", "[]", "embed", "from"])).toBe("fields[].embed.from");
  });

  test("extractPathName returns the last named segment", () => {
    expect(extractPathName("fields[].embed.from")).toBe("from");
    expect(extractPathName("fields[]")).toBe("fields");
    expect(extractPathName("joins.*")).toBe("joins");
  });
});
