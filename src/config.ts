import path from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { extractorConfigSchema } from "./config-schema.js";
import type { ParsedExtractorConfig } from "./config-schema.js";
import type {
  CliOptions,
  ExtractorConfig,
} from "./types.js";

export async function loadConfig(
  configPath: string,
  cliOptions: CliOptions,
): Promise<ExtractorConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absoluteConfigPath);
  const explorer = cosmiconfig("typesense-api-extractor", {
    searchPlaces: [
      "package.json",
      ".typesense-api-extractorrc",
      ".typesense-api-extractorrc.json",
      ".typesense-api-extractorrc.yaml",
      ".typesense-api-extractorrc.yml",
      ".typesense-api-extractorrc.js",
      "typesense-api-extractor.config.js",
      "config.json",
    ],
  });

  const result = await explorer.load(absoluteConfigPath);
  if (result === null) {
    throw new Error(`Could not load config file ${absoluteConfigPath}.`);
  }

  const parsedConfig = parseConfig(result.config, absoluteConfigPath);
  return {
    rootDir: parsedConfig.root_dir,
    routeFile: parsedConfig.route_file,
    sourceBranch: parsedConfig.source_branch,
    outputPath:
      cliOptions.outputPath !== undefined
        ? path.resolve(cliOptions.outputPath)
        : path.resolve(configDir, parsedConfig.output_path),
    diagnosticsOutputPath:
      parsedConfig.diagnostics_output_path === undefined
        ? undefined
        : path.resolve(configDir, parsedConfig.diagnostics_output_path),
    baseUrl: cliOptions.baseUrl ?? parsedConfig.base_url,
    maxCallDepth: cliOptions.maxCallDepth ?? parsedConfig.max_call_depth,
    failOnDiagnostics:
      cliOptions.failOnDiagnostics ?? parsedConfig.fail_on_diagnostics,
    failOnUnresolved:
      cliOptions.failOnUnresolved ?? parsedConfig.fail_on_unresolved,
    blacklist: parsedConfig.blacklist,
    includeHelpers: parsedConfig.include_helpers,
    overrides: parsedConfig.overrides,
    debug: {
      enabled: cliOptions.verbose || parsedConfig.debug.enabled,
      routeFilter: cliOptions.debugRoute ?? parsedConfig.debug.route_filter,
    },
  };
}

function parseConfig(
  config: unknown,
  configPath: string,
): ParsedExtractorConfig {
  const parsedConfig = extractorConfigSchema.safeParse(config);
  if (parsedConfig.success) {
    return parsedConfig.data;
  }

  const message = parsedConfig.error.errors
    .map(
      (error) =>
        `Error for config field '${error.path.join(".")}': ${error.message}`,
    )
    .join("\n");
  throw new Error(`Could not parse config file ${configPath}:\n${message}`);
}
