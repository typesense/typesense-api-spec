#!/usr/bin/env node

import { parseArgs } from "node:util";
import { runExtraction } from "./index.js";
import { runSemanticDiff } from "./semantic-diff.js";
import type {
  CommandLineOptions,
  SemanticDiffCliOptions,
  CliOptions,
} from "./types.js";

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.command === "extract") {
    const spec = await runExtraction(options);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ event: "result", routes: spec.routes.length, diagnostics: spec.diagnostics.length })}\n`,
      );
    } else {
      process.stdout.write(
        `Extracted ${spec.routes.length} routes with ${spec.diagnostics.length} diagnostics.\n`,
      );
    }
    return;
  }

  const summary = await runSemanticDiff({
    previousPath: options.previousPath,
    nextPath: options.nextPath,
    jsonOutputPath: options.jsonOutputPath,
    markdownOutputPath: options.markdownOutputPath,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function parseCli(argv: readonly string[]): CommandLineOptions {
  const command = argv[0] ?? "extract";
  const commandArgs = argv[0] === undefined ? argv : argv.slice(1);
  if (command === "extract") {
    return parseExtractCli(commandArgs);
  }
  if (command === "semantic-diff") {
    return parseSemanticDiffCli(commandArgs);
  }
  throw new Error(`Unknown command: ${command}`);
}
function parseExtractCli(argv: readonly string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: "string" },
      output: { type: "string" },
      "base-url": { type: "string" },
      "max-call-depth": { type: "string" },
      "fail-on-diagnostics": { type: "boolean" },
      "fail-on-unresolved": { type: "boolean" },
      verbose: { type: "boolean" },
      "debug-route": { type: "string" },
      json: { type: "boolean" },
    },
    strict: true,
  });

  if (positionals.length > 0) {
    throw new Error(`Unknown arguments: ${positionals.join(" ")}`);
  }

  let maxCallDepth: number | undefined;
  if (values["max-call-depth"] !== undefined) {
    maxCallDepth = Number.parseInt(values["max-call-depth"], 10);
    if (!Number.isFinite(maxCallDepth)) {
      throw new Error(
        `Invalid value for --max-call-depth: ${values["max-call-depth"]}`,
      );
    }
  }

  return {
    command: "extract",
    configPath: values.config,
    outputPath: values.output,
    baseUrl: values["base-url"],
    maxCallDepth,
    failOnDiagnostics: values["fail-on-diagnostics"],
    failOnUnresolved: values["fail-on-unresolved"],
    verbose: values.verbose ?? false,
    debugRoute: values["debug-route"],
    json: values.json ?? false,
  };
}

function parseSemanticDiffCli(argv: readonly string[]): SemanticDiffCliOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      previous: { type: "string" },
      next: { type: "string" },
      "json-output": { type: "string" },
      "markdown-output": { type: "string" },
    },
    strict: true,
  });

  if (positionals.length > 0) {
    throw new Error(`Unknown arguments: ${positionals.join(" ")}`);
  }
  if (values.previous === undefined || values.next === undefined) {
    throw new Error("Both --previous and --next are required.");
  }

  return {
    command: "semantic-diff",
    previousPath: values.previous,
    nextPath: values.next,
    jsonOutputPath: values["json-output"],
    markdownOutputPath: values["markdown-output"],
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
