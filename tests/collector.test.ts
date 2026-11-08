import { describe, expect, test } from "bun:test";
import { ParameterCollector } from "../src/analysis/collector.js";
import type { CollectedParameter, RouteRegistration } from "../src/types.js";

const read = (line: number): CollectedParameter => ({
  location: "body",
  canonicalPath: "field",
  valueType: "uint",
  source: { filePath: "file.cpp", line, column: 1 },
});

describe("ParameterCollector", () => {
  test("cites a parameter's first read", () => {
    const collector = new ParameterCollector({ pathTemplate: "/a" } as RouteRegistration);
    collector.add(read(10));
    collector.add(read(99));

    const [parameter] = collector.snapshot("body");
    expect(parameter?.source.line).toBe(10);
  });
});
