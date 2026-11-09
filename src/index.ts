import { loadStringConstants } from "./constants.js";
import { loadConfig } from "./config.js";
import { writeTextFile } from "./fs.js";
import { ProgressReporter } from "./progress.js";
import { discoverRoutes } from "./routes.js";
import { extractRouteData } from "./analysis.js";
import { buildSpec, isRouteExcluded } from "./spec.js";
import { indexFunctions } from "./symbols.js";
import { pinSourceCommit, resolveRawGithubUrl, resolveSourcePath, resolveSourceRef } from "./source.js";
import type { ApiSpec, CliOptions } from "./types.js";

export async function runExtraction(cliOptions: CliOptions): Promise<ApiSpec> {
  const progress = new ProgressReporter(cliOptions.json);
  const configStep = progress.startStep("loading config");
  const loadedConfig = await loadConfig(cliOptions.configPath ?? "./config.json", cliOptions);
  const config = { ...loadedConfig, sourceBranch: await resolveSourceRef(loadedConfig.sourceBranch) };
  configStep.done(config.sourceBranch);

  // Every file below is read at this commit, which the output records.
  const commitStep = progress.startStep("resolving source commit");
  const sourceCommit = await pinSourceCommit(config.sourceBranch);
  commitStep.done(sourceCommit);

  // These steps are independent, so fetch and parse their sources concurrently.
  const routesStep = progress.startStep("discovering routes");
  const constantsStep = progress.startStep("loading constants");
  const symbolsStep = progress.startStep("indexing functions");
  const [routes, constants, functions] = await Promise.all([
    discoverRoutes(resolveRawGithubUrl(config.sourceBranch, resolveSourcePath(config.rootDir, config.routeFile))).then(
      (result) => {
        routesStep.done(`${result.length} routes`);
        return result;
      },
    ),
    loadStringConstants(config.rootDir, config.sourceBranch).then((result) => {
      constantsStep.done(`${result.size} constants`);
      return result;
    }),
    indexFunctions(config.rootDir, config.includeHelpers, config.sourceBranch).then((result) => {
      symbolsStep.done(`${result.size} functions`);
      return result;
    }),
  ]);

  const extractStep = progress.startStep("extracting route parameters");
  const routeExtractions = routes
    .filter((route) => !isRouteExcluded(config, route.method, route.pathTemplate))
    .map((route) => extractRouteData(route, functions, constants, config.maxCallDepth, config.debug));
  extractStep.done(`${routeExtractions.length} route scans`);

  const specStep = progress.startStep("building output");
  const spec = buildSpec(
    config,
    routeExtractions,
    routeExtractions.flatMap((extraction) => extraction.diagnostics),
    sourceCommit,
  );
  const diagnostics = spec.diagnostics;
  const outputText = `${JSON.stringify(spec, null, 2)}\n`;
  await writeTextFile(config.outputPath, outputText);
  if (config.diagnosticsOutputPath !== undefined) {
    await writeTextFile(config.diagnosticsOutputPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
  }
  specStep.done(config.outputPath);

  if (config.failOnDiagnostics && diagnostics.length > 0) {
    throw new Error("Extraction produced diagnostics.");
  }

  if (config.failOnUnresolved && diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    throw new Error("Extraction produced unresolved handler errors.");
  }

  return spec;
}
