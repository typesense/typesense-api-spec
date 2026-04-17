import { loadStringConstants } from "./constants.js";
import { loadConfig } from "./config.js";
import { readTextFile, writeTextFile } from "./fs.js";
import { ProgressReporter } from "./progress.js";
import { discoverRoutes } from "./routes.js";
import { extractRouteData } from "./analysis.js";
import { buildSpec } from "./spec.js";
import { indexFunctions } from "./symbols.js";
import { resolveRawGithubUrl, resolveSourcePath } from "./source.js";
import type { ApiSpec, CliOptions } from "./types.js";

export async function runExtraction(cliOptions: CliOptions): Promise<ApiSpec> {
  const progress = new ProgressReporter(cliOptions.json);
  const configStep = progress.startStep("loading config");
  const config = await loadConfig(cliOptions.configPath ?? "./config.json", cliOptions);
  configStep.done();

  const routesStep = progress.startStep("discovering routes");
  const routes = await discoverRoutes(
    resolveRawGithubUrl(config.sourceBranch, resolveSourcePath(config.rootDir, config.routeFile)),
  );
  routesStep.done(`${routes.length} routes`);

  const constantsStep = progress.startStep("loading constants");
  const constants = await loadStringConstants(config.rootDir, config.sourceBranch);
  constantsStep.done(`${constants.size} constants`);

  const symbolsStep = progress.startStep("indexing functions");
  const functions = await indexFunctions(config.rootDir, config.includeHelpers, config.sourceBranch);
  symbolsStep.done(`${functions.size} functions`);

  const extractStep = progress.startStep("extracting route parameters");
  const routeExtractions = routes.map((route) =>
    extractRouteData(route, functions, constants, config.maxCallDepth, config.debug),
  );
  extractStep.done(`${routeExtractions.length} route scans`);

  const specStep = progress.startStep("building output");
  const diagnostics = routeExtractions.flatMap((extraction) => extraction.diagnostics);
  const spec = buildSpec(config, routeExtractions, diagnostics);
  const outputText = `${JSON.stringify(spec, null, 2)}\n`;
  await writeTextFile(config.outputPath, outputText);
  if (config.diagnosticsOutputPath !== undefined) {
    await writeTextFile(config.diagnosticsOutputPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
  }
  specStep.done(config.outputPath);

  if (config.failOnDiagnostics && diagnostics.length > 0) {
    throw new Error("Extraction produced diagnostics.");
  }

  if (
    config.failOnUnresolved &&
    diagnostics.some((diagnostic) => diagnostic.level === "error")
  ) {
    throw new Error("Extraction produced unresolved handler errors.");
  }

  return spec;
}

export async function readSpec(filePath: string): Promise<ApiSpec> {
  const sourceText = await readTextFile(filePath);
  return JSON.parse(sourceText) as ApiSpec;
}
