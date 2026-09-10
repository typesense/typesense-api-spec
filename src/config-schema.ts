import { z } from "zod";
import { HttpMethodMap } from "./types.js";

export const httpMethodSchema = z.nativeEnum(HttpMethodMap);

export const locationEnum = z.enum(["path", "query", "body"]);

export const routeOverrideParameterSchema = z.object({
  location: z.enum(["path", "query", "body"]),
  name: z.string().min(1),
  canonicalPath: z.string().min(1).optional(),
});

export const routeOverrideSchema = z.object({
  method: httpMethodSchema.optional(),
  path: z.string().min(1),
  skip: z.boolean().optional(),
  removeParams: z.array(z.string().min(1)).optional(),
  addParams: z.array(routeOverrideParameterSchema).optional(),
});

export const extractorConfigSchema = z
  .object({
    root_dir: z.string().default(""),
    route_file: z.string().min(1).default("src/main/typesense_server.cpp"),
    source_branch: z.string().min(1).default("v30"),
    output_path: z.string().min(1).default("./output/typesense_api_spec.json"),
    diagnostics_output_path: z
      .string()
      .min(1)
      .optional()
      .default("./output/typesense_api_diagnostics.json"),
    base_url: z.string().min(1).optional(),
    max_call_depth: z.number().finite().default(4),
    fail_on_diagnostics: z.boolean().default(false),
    fail_on_unresolved: z.boolean().default(false),
    include_helpers: z.array(z.string().min(1)).default([]),
    blacklist: z
      .object({
        paths: z.array(z.string().min(1)).default([]),
        params: z.array(z.string().min(1)).default([]),
      })
      .default({
        paths: [],
        params: [],
      }),
    overrides: z.array(routeOverrideSchema).default([]),
    debug: z
      .object({
        enabled: z.boolean().default(false),
        route_filter: z.string().min(1).optional(),
      })
      .default({
        enabled: false,
      }),
  })
  .strict();

export type RouteOverrideParameter = z.infer<
  typeof routeOverrideParameterSchema
>;
export type RouteOverride = z.infer<typeof routeOverrideSchema>;
export type ParsedExtractorConfig = z.infer<typeof extractorConfigSchema>;
export type ParameterLocation = z.infer<typeof locationEnum>;
