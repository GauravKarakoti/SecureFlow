import { z } from "zod";

export const GATE_LEVEL_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"] as const;
export type GateLevel = (typeof GATE_LEVEL_VALUES)[number];

export const gateLevelSchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"]);

export const gateOverrideSchema = z
  .object({
    type: z.string().min(1, "Override must have a non-empty string 'type'"),
    blockOn: gateLevelSchema.optional(),
    blockAt: gateLevelSchema.optional(),
    reviewOn: gateLevelSchema.optional(),
    reviewAt: gateLevelSchema.optional(),
  })
  .strict();

export type GateOverrideConfig = z.infer<typeof gateOverrideSchema>;

export const gatePathRuleSchema = z
  .object({
    glob: z.string().min(1, "Path rule must have a non-empty string 'glob'"),
    blockOn: gateLevelSchema.optional(),
    blockAt: gateLevelSchema.optional(),
    reviewOn: gateLevelSchema.optional(),
    reviewAt: gateLevelSchema.optional(),
  })
  .strict();

export type GatePathRuleConfig = z.infer<typeof gatePathRuleSchema>;

export const policyScopeRuleSchema = z
  .object({
    paths: z
      .array(z.string().min(1, "Path glob cannot be empty"))
      .min(1, "policyScopes entry must have at least one path"),
    enable: z.array(z.string()).optional(),
    disable: z.array(z.string()).optional(),
  })
  .strict();

export type PolicyScopeConfig = z.infer<typeof policyScopeRuleSchema>;

export const gateConfigSchema = z
  .object({
    blockOn: gateLevelSchema.optional(),
    blockAt: gateLevelSchema.optional(),
    reviewOn: gateLevelSchema.optional(),
    reviewAt: gateLevelSchema.optional(),
    overrides: z.array(gateOverrideSchema).optional(),
    paths: z.array(gatePathRuleSchema).optional(),
    policyScopes: z.array(policyScopeRuleSchema).optional(),
  })
  .strict();

export type GateConfigSchema = z.infer<typeof gateConfigSchema>;

export const secureFlowConfigSchema = z
  .object({
    $schema: z.string().optional(),
    $comment: z.string().optional(),
    gate: gateConfigSchema.optional(),
    policyScopes: z.array(policyScopeRuleSchema).optional(),
  })
  .strict();

export type SecureFlowConfigSchema = z.infer<typeof secureFlowConfigSchema>;

export interface ValidationError {
  file: string;
  line: number;
  column?: number | undefined;
  message: string;
  code:
    | "SYNTAX_ERROR"
    | "UNKNOWN_KEY"
    | "INVALID_SEVERITY"
    | "INVALID_GLOB"
    | "INVALID_TYPE"
    | "INVALID_EXPIRY"
    | "UNKNOWN_SECTION"
    | "FILE_NOT_FOUND";
}

export interface FileValidationResult {
  file: string;
  exists: boolean;
  valid: boolean;
  errors: ValidationError[];
}

export interface ConfigValidationReport {
  valid: boolean;
  files: Record<string, FileValidationResult>;
  allErrors: ValidationError[];
}

/**
 * Strips single-line (//) and multi-line (/* *\/) comments from JSON text,
 * replacing non-newline comment characters with whitespace to preserve line numbers and columns.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inSingleComment = false;
  let inMultiComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = i + 1 < text.length ? text[i + 1]! : "";

    if (inSingleComment) {
      if (ch === "\n" || ch === "\r") {
        inSingleComment = false;
        out += ch;
      } else {
        out += " ";
      }
      continue;
    }

    if (inMultiComment) {
      if (ch === "*" && next === "/") {
        inMultiComment = false;
        out += "  ";
        i++;
      } else {
        out += ch === "\n" || ch === "\r" ? ch : " ";
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (ch === "\\" && next) {
        out += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      inSingleComment = true;
      out += "  ";
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inMultiComment = true;
      out += "  ";
      i++;
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Validates whether a glob pattern is valid and can be safely compiled into a regular expression.
 */
export function isValidGlob(glob: unknown): glob is string {
  if (typeof glob !== "string") return false;
  const trimmed = glob.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("\0")) return false;

  // Unclosed bracket or brace checks
  let inBracket = false;
  let inBrace = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      if (inBracket) return false; // nested unclosed bracket
      inBracket = true;
    } else if (c === "]") {
      if (!inBracket) return false; // unmatched closing bracket
      inBracket = false;
    } else if (c === "{") {
      if (inBrace) return false;
      inBrace = true;
    } else if (c === "}") {
      if (!inBrace) return false;
      inBrace = false;
    }
  }
  if (inBracket || inBrace) return false;

  // Cannot contain triple asterisks
  if (trimmed.includes("***")) return false;

  return true;
}

/**
 * AST Node structure for parsed JSON with source locations.
 */
export interface JsonSourceNode {
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  line: number;
  column: number;
  value?: any;
  properties?:
    | {
        key: string;
        keyLine: number;
        keyColumn: number;
        valueNode: JsonSourceNode;
      }[]
    | undefined;
  items?: JsonSourceNode[] | undefined;
}

/**
 * Parses JSON (supporting single-line and multi-line comments) while tracking exact
 * line and column numbers for all keys and values.
 */
export function parseJsonWithSourceMap(
  content: string,
  filePath = ".secureflow.json",
): { root: JsonSourceNode | null; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  function advance() {
    const ch = content[index];
    index++;
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return ch;
  }

  function peek() {
    return content[index];
  }

  function skipWhitespaceAndComments() {
    while (index < content.length) {
      const ch = content[index];
      const next = index + 1 < content.length ? content[index + 1] : "";

      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        advance();
        continue;
      }

      if (ch === "/" && next === "/") {
        advance();
        advance();
        while (index < content.length && content[index] !== "\n" && content[index] !== "\r") {
          advance();
        }
        continue;
      }

      if (ch === "/" && next === "*") {
        advance();
        advance();
        while (index < content.length) {
          if (content[index] === "*" && index + 1 < content.length && content[index + 1] === "/") {
            advance();
            advance();
            break;
          }
          advance();
        }
        continue;
      }

      break;
    }
  }

  function parseString(): { value: string; line: number; column: number } | null {
    const startLine = line;
    const startCol = column;
    if (peek() !== '"') return null;
    advance(); // skip opening quote

    let result = "";
    while (index < content.length) {
      const ch = advance();
      if (ch === '"') {
        return { value: result, line: startLine, column: startCol };
      }
      if (ch === "\\") {
        if (index >= content.length) break;
        const esc = advance();
        switch (esc) {
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          case "/":
            result += "/";
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u": {
            const hex = content.slice(index, index + 4);
            if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
              for (let k = 0; k < 4; k++) advance();
              result += String.fromCharCode(parseInt(hex, 16));
            } else {
              result += "\\u";
            }
            break;
          }
          default:
            result += esc;
        }
      } else {
        result += ch;
      }
    }

    errors.push({
      file: filePath,
      line: startLine,
      column: startCol,
      message: "Unterminated string literal in JSON",
      code: "SYNTAX_ERROR",
    });
    return null;
  }

  function parseNumber(): JsonSourceNode | null {
    const startLine = line;
    const startCol = column;
    const numRegex = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
    const slice = content.slice(index);
    const match = slice.match(numRegex);
    if (!match || match.index !== 0) return null;

    const numStr = match[0];
    for (let i = 0; i < numStr.length; i++) advance();
    return {
      type: "number",
      line: startLine,
      column: startCol,
      value: Number(numStr),
    };
  }

  function parseValue(): JsonSourceNode | null {
    skipWhitespaceAndComments();
    if (index >= content.length) return null;

    const startLine = line;
    const startCol = column;
    const ch = peek();
    if (!ch) return null;

    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();

    if (ch === '"') {
      const str = parseString();
      if (!str) return null;
      return {
        type: "string",
        line: str.line,
        column: str.column,
        value: str.value,
      };
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      return parseNumber();
    }

    if (content.startsWith("true", index)) {
      for (let k = 0; k < 4; k++) advance();
      return { type: "boolean", line: startLine, column: startCol, value: true };
    }

    if (content.startsWith("false", index)) {
      for (let k = 0; k < 5; k++) advance();
      return { type: "boolean", line: startLine, column: startCol, value: false };
    }

    if (content.startsWith("null", index)) {
      for (let k = 0; k < 4; k++) advance();
      return { type: "null", line: startLine, column: startCol, value: null };
    }

    errors.push({
      file: filePath,
      line: startLine,
      column: startCol,
      message: `Unexpected token '${ch}' in JSON`,
      code: "SYNTAX_ERROR",
    });
    advance();
    return null;
  }

  function parseObject(): JsonSourceNode | null {
    const startLine = line;
    const startCol = column;
    advance(); // skip '{'
    const properties: NonNullable<JsonSourceNode["properties"]> = [];

    skipWhitespaceAndComments();
    if (peek() === "}") {
      advance();
      return { type: "object", line: startLine, column: startCol, properties };
    }

    while (index < content.length) {
      skipWhitespaceAndComments();
      if (peek() === "}") {
        advance();
        break;
      }

      const keyStr = parseString();
      if (!keyStr) {
        errors.push({
          file: filePath,
          line,
          column,
          message: "Expected string key in JSON object",
          code: "SYNTAX_ERROR",
        });
        break;
      }

      skipWhitespaceAndComments();
      if (peek() !== ":") {
        errors.push({
          file: filePath,
          line,
          column,
          message: `Expected ':' after key "${keyStr.value}"`,
          code: "SYNTAX_ERROR",
        });
        break;
      }
      advance(); // skip ':'

      const val = parseValue();
      if (!val) {
        errors.push({
          file: filePath,
          line,
          column,
          message: `Expected value for key "${keyStr.value}"`,
          code: "SYNTAX_ERROR",
        });
        break;
      }

      properties.push({
        key: keyStr.value,
        keyLine: keyStr.line,
        keyColumn: keyStr.column,
        valueNode: val,
      });

      skipWhitespaceAndComments();
      if (peek() === ",") {
        advance();
        skipWhitespaceAndComments();
        if (peek() === "}") {
          advance();
          break;
        }
      } else if (peek() === "}") {
        advance();
        break;
      } else {
        errors.push({
          file: filePath,
          line,
          column,
          message: "Expected ',' or '}' in JSON object",
          code: "SYNTAX_ERROR",
        });
        break;
      }
    }

    return { type: "object", line: startLine, column: startCol, properties };
  }

  function parseArray(): JsonSourceNode | null {
    const startLine = line;
    const startCol = column;
    advance(); // skip '['
    const items: JsonSourceNode[] = [];

    skipWhitespaceAndComments();
    if (peek() === "]") {
      advance();
      return { type: "array", line: startLine, column: startCol, items };
    }

    while (index < content.length) {
      skipWhitespaceAndComments();
      if (peek() === "]") {
        advance();
        break;
      }

      const item = parseValue();
      if (!item) break;
      items.push(item);

      skipWhitespaceAndComments();
      if (peek() === ",") {
        advance();
        skipWhitespaceAndComments();
        if (peek() === "]") {
          advance();
          break;
        }
      } else if (peek() === "]") {
        advance();
        break;
      } else {
        errors.push({
          file: filePath,
          line,
          column,
          message: "Expected ',' or ']' in JSON array",
          code: "SYNTAX_ERROR",
        });
        break;
      }
    }

    return { type: "array", line: startLine, column: startCol, items };
  }

  skipWhitespaceAndComments();
  const root = parseValue();
  skipWhitespaceAndComments();

  if (index < content.length && errors.length === 0) {
    errors.push({
      file: filePath,
      line,
      column,
      message: `Unexpected trailing token '${peek()}' after top-level JSON value`,
      code: "SYNTAX_ERROR",
    });
  }

  return { root, errors };
}

/**
 * Validates a `.secureflow.json` configuration file string, reporting all unknown keys,
 * invalid severities, and invalid globs with exact line numbers.
 */
export function validateSecureFlowJson(
  content: string,
  filePath = ".secureflow.json",
): ValidationError[] {
  const { root, errors } = parseJsonWithSourceMap(content, filePath);
  if (errors.length > 0 || !root) {
    return errors;
  }

  if (root.type !== "object" || !root.properties) {
    errors.push({
      file: filePath,
      line: root.line,
      column: root.column,
      message: `Top-level value in ${filePath} must be an object`,
      code: "INVALID_TYPE",
    });
    return errors;
  }

  const allowedRootKeys = new Set(["$schema", "$comment", "gate", "policyScopes"]);

  for (const prop of root.properties) {
    if (!allowedRootKeys.has(prop.key)) {
      errors.push({
        file: filePath,
        line: prop.keyLine,
        column: prop.keyColumn,
        message: `Unknown key "${prop.key}" at root level. Allowed keys: gate, policyScopes, $schema, $comment`,
        code: "UNKNOWN_KEY",
      });
      continue;
    }

    if (prop.key === "gate") {
      validateGateNode(prop.valueNode, filePath, errors);
    } else if (prop.key === "policyScopes") {
      validatePolicyScopesNode(prop.valueNode, filePath, "policyScopes", errors);
    }
  }

  return errors;
}

function validateSeverityValue(
  node: JsonSourceNode,
  fieldName: string,
  filePath: string,
  errors: ValidationError[],
): void {
  if (node.type !== "string") {
    errors.push({
      file: filePath,
      line: node.line,
      column: node.column,
      message: `"${fieldName}" must be a string. Expected one of: CRITICAL, HIGH, MEDIUM, LOW, NONE`,
      code: "INVALID_SEVERITY",
    });
    return;
  }

  const upper = (node.value as string).trim().toUpperCase();
  if (!GATE_LEVEL_VALUES.includes(upper as GateLevel)) {
    errors.push({
      file: filePath,
      line: node.line,
      column: node.column,
      message: `Invalid severity "${node.value}" for "${fieldName}". Expected one of: CRITICAL, HIGH, MEDIUM, LOW, NONE`,
      code: "INVALID_SEVERITY",
    });
  }
}

function validateGateNode(
  gateNode: JsonSourceNode,
  filePath: string,
  errors: ValidationError[],
): void {
  if (gateNode.type !== "object" || !gateNode.properties) {
    errors.push({
      file: filePath,
      line: gateNode.line,
      column: gateNode.column,
      message: `'gate' must be an object`,
      code: "INVALID_TYPE",
    });
    return;
  }

  const allowedGateKeys = new Set([
    "blockOn",
    "blockAt",
    "reviewOn",
    "reviewAt",
    "overrides",
    "paths",
    "policyScopes",
  ]);

  for (const prop of gateNode.properties) {
    if (!allowedGateKeys.has(prop.key)) {
      errors.push({
        file: filePath,
        line: prop.keyLine,
        column: prop.keyColumn,
        message: `Unknown key "${prop.key}" in "gate". Allowed keys: blockOn, reviewOn, overrides, paths, policyScopes`,
        code: "UNKNOWN_KEY",
      });
      continue;
    }

    if (
      prop.key === "blockOn" ||
      prop.key === "blockAt" ||
      prop.key === "reviewOn" ||
      prop.key === "reviewAt"
    ) {
      validateSeverityValue(prop.valueNode, `gate.${prop.key}`, filePath, errors);
    } else if (prop.key === "overrides") {
      validateOverridesNode(prop.valueNode, filePath, errors);
    } else if (prop.key === "paths") {
      validatePathsNode(prop.valueNode, filePath, errors);
    } else if (prop.key === "policyScopes") {
      validatePolicyScopesNode(prop.valueNode, filePath, "gate.policyScopes", errors);
    }
  }
}

function validateOverridesNode(
  node: JsonSourceNode,
  filePath: string,
  errors: ValidationError[],
): void {
  if (node.type !== "array" || !node.items) {
    errors.push({
      file: filePath,
      line: node.line,
      column: node.column,
      message: `'gate.overrides' must be an array`,
      code: "INVALID_TYPE",
    });
    return;
  }

  const allowedOverrideKeys = new Set(["type", "blockOn", "blockAt", "reviewOn", "reviewAt"]);

  node.items.forEach((item, index) => {
    if (item.type !== "object" || !item.properties) {
      errors.push({
        file: filePath,
        line: item.line,
        column: item.column,
        message: `gate.overrides[${index}] must be an object`,
        code: "INVALID_TYPE",
      });
      return;
    }

    let hasType = false;
    for (const prop of item.properties) {
      if (!allowedOverrideKeys.has(prop.key)) {
        errors.push({
          file: filePath,
          line: prop.keyLine,
          column: prop.keyColumn,
          message: `Unknown key "${prop.key}" in gate.overrides[${index}]`,
          code: "UNKNOWN_KEY",
        });
        continue;
      }

      if (prop.key === "type") {
        hasType = true;
        if (prop.valueNode.type !== "string" || !prop.valueNode.value?.trim()) {
          errors.push({
            file: filePath,
            line: prop.valueNode.line,
            column: prop.valueNode.column,
            message: `gate.overrides[${index}].type must be a non-empty string`,
            code: "INVALID_TYPE",
          });
        }
      } else {
        validateSeverityValue(
          prop.valueNode,
          `gate.overrides[${index}].${prop.key}`,
          filePath,
          errors,
        );
      }
    }

    if (!hasType) {
      errors.push({
        file: filePath,
        line: item.line,
        column: item.column,
        message: `gate.overrides[${index}] is missing required field 'type'`,
        code: "INVALID_TYPE",
      });
    }
  });
}

function validatePathsNode(
  node: JsonSourceNode,
  filePath: string,
  errors: ValidationError[],
): void {
  if (node.type !== "array" || !node.items) {
    errors.push({
      file: filePath,
      line: node.line,
      column: node.column,
      message: `'gate.paths' must be an array`,
      code: "INVALID_TYPE",
    });
    return;
  }

  const allowedPathKeys = new Set(["glob", "blockOn", "blockAt", "reviewOn", "reviewAt"]);

  node.items.forEach((item, index) => {
    if (item.type !== "object" || !item.properties) {
      errors.push({
        file: filePath,
        line: item.line,
        column: item.column,
        message: `gate.paths[${index}] must be an object`,
        code: "INVALID_TYPE",
      });
      return;
    }

    let hasGlob = false;
    for (const prop of item.properties) {
      if (!allowedPathKeys.has(prop.key)) {
        errors.push({
          file: filePath,
          line: prop.keyLine,
          column: prop.keyColumn,
          message: `Unknown key "${prop.key}" in gate.paths[${index}]`,
          code: "UNKNOWN_KEY",
        });
        continue;
      }

      if (prop.key === "glob") {
        hasGlob = true;
        if (prop.valueNode.type !== "string") {
          errors.push({
            file: filePath,
            line: prop.valueNode.line,
            column: prop.valueNode.column,
            message: `gate.paths[${index}].glob must be a string`,
            code: "INVALID_TYPE",
          });
        } else if (!isValidGlob(prop.valueNode.value)) {
          errors.push({
            file: filePath,
            line: prop.valueNode.line,
            column: prop.valueNode.column,
            message: `Invalid glob pattern "${prop.valueNode.value}" in gate.paths[${index}].glob`,
            code: "INVALID_GLOB",
          });
        }
      } else {
        validateSeverityValue(prop.valueNode, `gate.paths[${index}].${prop.key}`, filePath, errors);
      }
    }

    if (!hasGlob) {
      errors.push({
        file: filePath,
        line: item.line,
        column: item.column,
        message: `gate.paths[${index}] is missing required field 'glob'`,
        code: "INVALID_TYPE",
      });
    }
  });
}

function validatePolicyScopesNode(
  node: JsonSourceNode,
  filePath: string,
  sectionName: string,
  errors: ValidationError[],
): void {
  if (node.type !== "array" || !node.items) {
    errors.push({
      file: filePath,
      line: node.line,
      column: node.column,
      message: `'${sectionName}' must be an array`,
      code: "INVALID_TYPE",
    });
    return;
  }

  const allowedScopeKeys = new Set(["paths", "enable", "disable"]);

  node.items.forEach((item, index) => {
    if (item.type !== "object" || !item.properties) {
      errors.push({
        file: filePath,
        line: item.line,
        column: item.column,
        message: `${sectionName}[${index}] must be an object`,
        code: "INVALID_TYPE",
      });
      return;
    }

    let hasPaths = false;
    for (const prop of item.properties) {
      if (!allowedScopeKeys.has(prop.key)) {
        errors.push({
          file: filePath,
          line: prop.keyLine,
          column: prop.keyColumn,
          message: `Unknown key "${prop.key}" in ${sectionName}[${index}]. Allowed keys: paths, enable, disable`,
          code: "UNKNOWN_KEY",
        });
        continue;
      }

      if (prop.key === "paths") {
        hasPaths = true;
        if (prop.valueNode.type !== "array" || !prop.valueNode.items) {
          errors.push({
            file: filePath,
            line: prop.valueNode.line,
            column: prop.valueNode.column,
            message: `${sectionName}[${index}].paths must be an array of glob strings`,
            code: "INVALID_TYPE",
          });
        } else if (prop.valueNode.items.length === 0) {
          errors.push({
            file: filePath,
            line: prop.valueNode.line,
            column: prop.valueNode.column,
            message: `${sectionName}[${index}].paths must contain at least one path pattern`,
            code: "INVALID_TYPE",
          });
        } else {
          prop.valueNode.items.forEach((pathItem, pIndex) => {
            if (pathItem.type !== "string") {
              errors.push({
                file: filePath,
                line: pathItem.line,
                column: pathItem.column,
                message: `${sectionName}[${index}].paths[${pIndex}] must be a string`,
                code: "INVALID_TYPE",
              });
            } else if (!isValidGlob(pathItem.value)) {
              errors.push({
                file: filePath,
                line: pathItem.line,
                column: pathItem.column,
                message: `Invalid glob pattern "${pathItem.value}" in ${sectionName}[${index}].paths[${pIndex}]`,
                code: "INVALID_GLOB",
              });
            }
          });
        }
      } else if (prop.key === "enable" || prop.key === "disable") {
        if (prop.valueNode.type !== "array" || !prop.valueNode.items) {
          errors.push({
            file: filePath,
            line: prop.valueNode.line,
            column: prop.valueNode.column,
            message: `${sectionName}[${index}].${prop.key} must be an array of policy names`,
            code: "INVALID_TYPE",
          });
        } else {
          prop.valueNode.items.forEach((itemNode, iIdx) => {
            if (itemNode.type !== "string") {
              errors.push({
                file: filePath,
                line: itemNode.line,
                column: itemNode.column,
                message: `${sectionName}[${index}].${prop.key}[${iIdx}] must be a string`,
                code: "INVALID_TYPE",
              });
            }
          });
        }
      }
    }

    if (!hasPaths) {
      errors.push({
        file: filePath,
        line: item.line,
        column: item.column,
        message: `${sectionName}[${index}] is missing required field 'paths'`,
        code: "INVALID_TYPE",
      });
    }
  });
}

/**
 * Validates a `.secureflowignore` file content line-by-line, reporting invalid globs,
 * unknown section headers, and malformed dates with exact line numbers.
 */
export function validateSecureFlowIgnore(
  content: string,
  filePath = ".secureflowignore",
): ValidationError[] {
  const errors: ValidationError[] = [];
  const lines = content.split(/\r?\n/);
  const allowedSections = new Set(["paths", "files", "placeholders", "mocks"]);

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }

    // Section header check
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const sectionName = trimmed.slice(1, -1).trim().toLowerCase();
      if (!allowedSections.has(sectionName)) {
        errors.push({
          file: filePath,
          line: lineNum,
          message: `Unknown section header "${trimmed}" in ${filePath}. Allowed sections: [paths], [files], [placeholders], [mocks]`,
          code: "UNKNOWN_SECTION",
        });
      }
      continue;
    }

    // JSON line support: {"pattern": "...", ...}
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        const pattern = parsed.pattern ?? parsed.path ?? parsed.glob;
        if (!pattern || typeof pattern !== "string") {
          errors.push({
            file: filePath,
            line: lineNum,
            message: `JSON rule entry missing required 'pattern' in ${filePath}`,
            code: "INVALID_GLOB",
          });
        } else if (!isValidGlob(pattern)) {
          errors.push({
            file: filePath,
            line: lineNum,
            message: `Invalid glob pattern "${pattern}" in ${filePath}`,
            code: "INVALID_GLOB",
          });
        }

        const expires = parsed.expires ?? parsed.expiry;
        if (expires && !isValidExpiryDate(String(expires))) {
          errors.push({
            file: filePath,
            line: lineNum,
            message: `Invalid expiry date "${expires}" in ${filePath}. Expected YYYY-MM-DD`,
            code: "INVALID_EXPIRY",
          });
        }
      } catch (err) {
        errors.push({
          file: filePath,
          line: lineNum,
          message: `Invalid JSON entry on line in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          code: "SYNTAX_ERROR",
        });
      }
      continue;
    }

    // Extract attributes and pattern
    let patternPart = trimmed;

    // Check expiry attribute: [expires=...]
    const expiresMatch = patternPart.match(/\[expires[:=]\s*([^\]]+)\]/i);
    if (expiresMatch && expiresMatch[1]) {
      const expStr = expiresMatch[1].trim();
      if (!isValidExpiryDate(expStr)) {
        errors.push({
          file: filePath,
          line: lineNum,
          message: `Invalid expiry date "${expStr}" in ${filePath}. Expected YYYY-MM-DD`,
          code: "INVALID_EXPIRY",
        });
      }
      patternPart = patternPart.replace(expiresMatch[0], " ").trim();
    }

    // Strip reason bracket: [reason=...]
    const reasonMatch = patternPart.match(/\[reason[:=]\s*([^\]]+)\]/i);
    if (reasonMatch) {
      patternPart = patternPart.replace(reasonMatch[0], " ").trim();
    }

    // Strip trailing comment: pattern # reason
    const commentIdx = patternPart.search(/\s+#/);
    if (commentIdx !== -1) {
      const comment = patternPart
        .slice(commentIdx)
        .replace(/^\s+#\s*/, "")
        .trim();
      const commentExpiryMatch = comment.match(/expires[:=]\s*(\S+)/i);
      if (commentExpiryMatch && commentExpiryMatch[1]) {
        const expStr = commentExpiryMatch[1].trim();
        if (!isValidExpiryDate(expStr)) {
          errors.push({
            file: filePath,
            line: lineNum,
            message: `Invalid expiry date "${expStr}" in ${filePath}. Expected YYYY-MM-DD`,
            code: "INVALID_EXPIRY",
          });
        }
      }
      patternPart = patternPart.slice(0, commentIdx).trim();
    }

    // Strip colon separator: pattern: reason
    const colonIdx = patternPart.indexOf(":");
    if (colonIdx > 0) {
      patternPart = patternPart.slice(0, colonIdx).trim();
    }

    // Validate the glob pattern
    if (!patternPart || !isValidGlob(patternPart)) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Invalid glob pattern "${patternPart}" in ${filePath}`,
        code: "INVALID_GLOB",
      });
    }
  }

  return errors;
}

/**
 * Validates whether an expiry date string is a valid YYYY-MM-DD calendar date.
 */
export function isValidExpiryDate(dateStr: string): boolean {
  const trimmed = dateStr.trim();
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!ymdMatch || !ymdMatch[1] || !ymdMatch[2] || !ymdMatch[3]) {
    const parsed = new Date(trimmed);
    return !isNaN(parsed.getTime());
  }

  const year = parseInt(ymdMatch[1], 10);
  const month = parseInt(ymdMatch[2], 10);
  const day = parseInt(ymdMatch[3], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
