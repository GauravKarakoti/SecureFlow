import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export function generateTypeScriptFromOpenApi(yamlContent: string): string {
  const spec = parse(yamlContent);
  const schemas = spec.components?.schemas || {};
  const paths = spec.paths || {};

  const lines: string[] = [];

  lines.push("/**");
  lines.push(" * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY.");
  lines.push(" * Generated from openapi.yaml via scripts/generate-api-client.ts.");
  lines.push(" * Run `npm run client:generate` to regenerate.");
  lines.push(" */");
  lines.push("");

  function schemaToTsType(schema: any, indent = 0): string {
    if (!schema) return "unknown";
    if (schema.$ref) {
      const refName = schema.$ref.split("/").pop();
      return `components["schemas"]["${refName}"]`;
    }
    if (schema.enum && Array.isArray(schema.enum)) {
      return schema.enum.map((e: any) => JSON.stringify(e)).join(" | ") || "string";
    }
    if (schema.type === "string") {
      return "string";
    }
    if (schema.type === "integer" || schema.type === "number") {
      return "number";
    }
    if (schema.type === "boolean") {
      return "boolean";
    }
    if (schema.type === "null") {
      return "null";
    }
    if (schema.type === "array") {
      const itemType = schemaToTsType(schema.items, indent);
      return `Array<${itemType}>`;
    }
    if (schema.type === "object" || schema.properties || schema.additionalProperties) {
      const props = schema.properties || {};
      const required = new Set(schema.required || []);
      const entries = Object.entries(props);
      if (entries.length === 0 && !schema.additionalProperties) {
        return "Record<string, unknown>";
      }
      const pad = "  ".repeat(indent + 1);
      const closePad = "  ".repeat(indent);
      const propLines: string[] = [];
      for (const [propName, propSchema] of entries) {
        const isReq = required.has(propName);
        const propType = schemaToTsType(propSchema, indent + 1);
        const opt = isReq ? "" : "?";
        const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(propName)
          ? propName
          : JSON.stringify(propName);
        propLines.push(`${pad}${key}${opt}: ${propType};`);
      }
      if (schema.additionalProperties) {
        const addType =
          typeof schema.additionalProperties === "object"
            ? schemaToTsType(schema.additionalProperties, indent + 1)
            : "unknown";
        propLines.push(`${pad}[key: string]: ${addType};`);
      }
      return `{\n${propLines.join("\n")}\n${closePad}}`;
    }
    if (schema.oneOf && Array.isArray(schema.oneOf)) {
      return schema.oneOf.map((s: any) => schemaToTsType(s, indent)).join(" | ");
    }
    if (schema.anyOf && Array.isArray(schema.anyOf)) {
      return schema.anyOf.map((s: any) => schemaToTsType(s, indent)).join(" | ");
    }
    if (schema.allOf && Array.isArray(schema.allOf)) {
      return schema.allOf.map((s: any) => schemaToTsType(s, indent)).join(" & ");
    }
    return "unknown";
  }

  // 1. Generate components
  lines.push("export interface paths {");
  for (const [pathStr, pathItem] of Object.entries(paths) as [string, any][]) {
    lines.push(`  "${pathStr}": {`);
    for (const [method, op] of Object.entries(pathItem)) {
      if (
        !["get", "post", "put", "patch", "delete", "options", "head"].includes(
          method.toLowerCase()
        )
      ) {
        continue;
      }
      lines.push(`    "${method.toLowerCase()}": {`);
      if (op.parameters && op.parameters.length > 0) {
        const queryParams = op.parameters.filter((p: any) => p.in === "query");
        const pathParams = op.parameters.filter((p: any) => p.in === "path");
        const headerParams = op.parameters.filter((p: any) => p.in === "header");

        lines.push("      parameters: {");
        if (queryParams.length > 0) {
          lines.push("        query?: {");
          for (const q of queryParams) {
            const opt = q.required ? "" : "?";
            const qType = schemaToTsType(q.schema, 4);
            lines.push(`          "${q.name}"${opt}: ${qType};`);
          }
          lines.push("        };");
        }
        if (pathParams.length > 0) {
          lines.push("        path: {");
          for (const p of pathParams) {
            const opt = p.required === false ? "?" : "";
            const pType = schemaToTsType(p.schema, 4);
            lines.push(`          "${p.name}"${opt}: ${pType};`);
          }
          lines.push("        };");
        }
        if (headerParams.length > 0) {
          lines.push("        header?: {");
          for (const h of headerParams) {
            const opt = h.required ? "" : "?";
            const hType = schemaToTsType(h.schema, 4);
            lines.push(`          "${h.name}"${opt}: ${hType};`);
          }
          lines.push("        };");
        }
        lines.push("      };");
      }
      if (op.requestBody) {
        const content = op.requestBody.content || {};
        const jsonSchema =
          content["application/json"]?.schema || content["*/*"]?.schema;
        lines.push("      requestBody?: {");
        lines.push("        content: {");
        if (jsonSchema) {
          lines.push(
            `          "application/json": ${schemaToTsType(jsonSchema, 5)};`
          );
        } else {
          lines.push('          "application/json": unknown;');
        }
        lines.push("        };");
        lines.push("      };");
      }
      lines.push("      responses: {");
      const responses = op.responses || {};
      for (const [code, resp] of Object.entries(responses) as [string, any][]) {
        lines.push(`        "${code}": {`);
        if (resp.content) {
          lines.push("          content: {");
          for (const [mediaType, mediaObj] of Object.entries(resp.content) as [
            string,
            any,
          ][]) {
            const respSchema = mediaObj.schema;
            lines.push(
              `            "${mediaType}": ${schemaToTsType(respSchema, 6)};`
            );
          }
          lines.push("          };");
        }
        lines.push("        };");
      }
      lines.push("      };");
      lines.push("    };");
    }
    lines.push("  };");
  }
  lines.push("}");
  lines.push("");

  // 2. Components
  lines.push("export interface components {");
  lines.push("  schemas: {");
  for (const [schemaName, schemaObj] of Object.entries(schemas)) {
    lines.push(`    "${schemaName}": ${schemaToTsType(schemaObj, 2)};`);
  }
  lines.push("  };");
  lines.push("}");
  lines.push("");

  // 3. Operations map
  lines.push("export interface operations {");
  for (const [pathStr, pathItem] of Object.entries(paths) as [string, any][]) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (
        ["get", "post", "put", "patch", "delete", "options", "head"].includes(
          method.toLowerCase()
        ) &&
        op.operationId
      ) {
        lines.push(
          `  "${op.operationId}": paths["${pathStr}"]["${method.toLowerCase()}"];`
        );
      }
    }
  }
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

export function generateApiClient(options: {
  specPath?: string;
  outputPath?: string;
  checkOnly?: boolean;
} = {}): {
  code: string;
  isUpToDate: boolean;
  outputPath: string;
} {
  const specPath = options.specPath || path.resolve(process.cwd(), "openapi.yaml");
  const outputPath =
    options.outputPath ||
    path.resolve(process.cwd(), "packages/api-client/src/schema.ts");

  if (!fs.existsSync(specPath)) {
    throw new Error(`OpenAPI specification not found at ${specPath}`);
  }

  const yamlContent = fs.readFileSync(specPath, "utf8");
  const generatedCode = generateTypeScriptFromOpenApi(yamlContent);

  let isUpToDate = false;
  if (fs.existsSync(outputPath)) {
    const existing = fs.readFileSync(outputPath, "utf8");
    // Normalize line endings for reliable comparison
    const normExisting = existing.replace(/\r\n/g, "\n");
    const normGenerated = generatedCode.replace(/\r\n/g, "\n");
    isUpToDate = normExisting === normGenerated;
  }

  if (!options.checkOnly) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, generatedCode, "utf8");
  }

  return {
    code: generatedCode,
    isUpToDate,
    outputPath,
  };
}

const isMain =
  process.argv[1] &&
  /generate-api-client(\.ts|\.js|\.mjs)?$/.test(process.argv[1]);

if (isMain) {
  const checkOnly = process.argv.includes("--check");
  try {
    const result = generateApiClient({ checkOnly });
    if (checkOnly) {
      if (result.isUpToDate) {
        console.log("✅ [api-client] Generated client is up to date with openapi.yaml.");
        process.exit(0);
      } else {
        console.error(
          "❌ [api-client] Out of date! Generated API client differs from openapi.yaml.\nRun `npm run client:generate` and commit the updated client."
        );
        process.exit(1);
      }
    } else {
      console.log(`✅ [api-client] Successfully generated TypeScript types at ${result.outputPath}`);
    }
  } catch (err: any) {
    console.error(`❌ [api-client] Error: ${err.message}`);
    process.exit(1);
  }
}
