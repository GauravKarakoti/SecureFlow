/**
 * AST Semantic Taint Analysis Engine (#2062)
 *
 * Performs intra-procedural taint propagation across abstract syntax trees (AST)
 * to trace sensitive sources (process.env, credentials, user inputs) flowing through
 * variable assignments, template strings, and concatenations into sensitive sinks
 * (database queries, shell executions, and console loggers).
 *
 * C and C++ files are handed to the lexical QNX rules in ./qnx-ddk-rules (#2211).
 */

import ts from "typescript";
import type { Severity, Violation } from "./scanner.js";
import { isSecretIdentifier } from "./scanner.js";
import { shouldRunQnxAnalysis, scanQnxSource } from "./qnx-ddk-rules.js";

export type TaintSourceType = "env" | "secret_identifier" | "user_input";

export interface TaintInfo {
  sourceText: string;
  type: TaintSourceType;
  line: number;
}

const SANITIZER_NAMES = new Set([
  "masksecret",
  "mask",
  "redact",
  "redactsecret",
  "sanitize",
  "sanitizesql",
  "hash",
  "sha256",
  "sha1",
  "md5",
  "encodeuricomponent",
  "encodeuri",
  "escape",
  "escapehtml",
  "escapesql",
]);

const DATABASE_SINK_METHODS = new Set([
  "query",
  "raw",
  "execute",
  "$queryrawunsafe",
  "$executeRawUnsafe",
]);

const SHELL_SINK_METHODS = new Set(["exec", "execsync", "spawn", "spawnsync"]);

const CONSOLE_METHODS = new Set(["log", "info", "warn", "error", "debug", "trace", "dir", "table"]);

/**
 * Returns true if the file extension is eligible for AST analysis.
 */
export function shouldRunAstAnalysis(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    shouldRunQnxAnalysis(lower) ||
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  );
}

/**
 * Checks if a call expression represents a recognized sanitizer function.
 */
function isSanitizerCall(callExpr: ts.CallExpression): boolean {
  let name = "";
  if (ts.isIdentifier(callExpr.expression)) {
    name = callExpr.expression.text;
  } else if (ts.isPropertyAccessExpression(callExpr.expression)) {
    name = callExpr.expression.name.text;
  }
  return SANITIZER_NAMES.has(name.toLowerCase());
}

/**
 * Checks if an expression directly accesses environment variables.
 */
function isEnvAccess(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    const parentExpr = node.expression;
    if (ts.isPropertyAccessExpression(parentExpr)) {
      if (
        ts.isIdentifier(parentExpr.expression) &&
        parentExpr.expression.text === "process" &&
        parentExpr.name.text === "env"
      ) {
        return true;
      }
    }
    // import.meta.env.*
    if (ts.isMetaProperty(parentExpr) && ts.isIdentifier(node.name) && node.name.text === "env") {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates whether an AST node is a taint source or tainted expression.
 */
function evaluateTaint(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  taintScope: Map<string, TaintInfo>,
): TaintInfo | null {
  // If wrapped in a sanitizer, taint is cleared
  if (ts.isCallExpression(node) && isSanitizerCall(node)) {
    return null;
  }

  // Check 1: process.env access
  if (isEnvAccess(node)) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    return {
      sourceText: node.getText(sourceFile),
      type: "env",
      line,
    };
  }

  // Check 2: Variable identifier matching secret words or previously tainted
  if (ts.isIdentifier(node)) {
    const name = node.text;
    const knownTaint = taintScope.get(name);
    if (knownTaint) {
      return knownTaint;
    }
    if (isSecretIdentifier(name)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      return {
        sourceText: name,
        type: "secret_identifier",
        line,
      };
    }
  }

  // Check 3: Property access on req.body / req.query / req.params (user input)
  if (ts.isPropertyAccessExpression(node)) {
    const objText = node.expression.getText(sourceFile);
    if (
      objText === "req.body" ||
      objText === "req.query" ||
      objText === "req.params" ||
      objText === "request.body"
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      return {
        sourceText: node.getText(sourceFile),
        type: "user_input",
        line,
      };
    }

    // Check if accessing property of tainted identifier
    const baseTaint = evaluateTaint(node.expression, sourceFile, taintScope);
    if (baseTaint) {
      return baseTaint;
    }
  }

  // Check 4: Template expression `...${tainted}...`
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const spanTaint = evaluateTaint(span.expression, sourceFile, taintScope);
      if (spanTaint) {
        return spanTaint;
      }
    }
  }

  // Check 5: Binary expression `a + b` (concatenation)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const leftTaint = evaluateTaint(node.left, sourceFile, taintScope);
    if (leftTaint) return leftTaint;
    const rightTaint = evaluateTaint(node.right, sourceFile, taintScope);
    if (rightTaint) return rightTaint;
  }

  return null;
}

/**
 * Scans JavaScript / TypeScript source code using AST semantic taint tracking.
 */
export function scanFileWithAst(filePath: string, content: string): Violation[] {
  if (!shouldRunAstAnalysis(filePath)) {
    return [];
  }

  // C / C++ goes to the QNX driver and real-time rules (#2211)
  if (shouldRunQnxAnalysis(filePath)) {
    return scanQnxSource(filePath, content);
  }

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  } catch {
    return [];
  }

  const violations: Violation[] = [];
  const taintScope = new Map<string, TaintInfo>();

  function getLineText(pos: number): string {
    const { line } = sourceFile.getLineAndCharacterOfPosition(pos);
    const lineStarts = sourceFile.getLineStarts();
    const start = lineStarts[line] ?? 0;
    const end =
      line + 1 < lineStarts.length ? (lineStarts[line + 1] ?? content.length) : content.length;
    return content
      .slice(start, end)
      .replace(/\r?\n$/, "")
      .trim();
  }

  function visit(node: ts.Node): void {
    // 1. Track variable declarations and assignments
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const varName = node.name.text;
      const taint = evaluateTaint(node.initializer, sourceFile, taintScope);
      if (taint) {
        taintScope.set(varName, taint);
      } else {
        taintScope.delete(varName);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const varName = node.left.text;
      const taint = evaluateTaint(node.right, sourceFile, taintScope);
      if (taint) {
        taintScope.set(varName, taint);
      } else {
        taintScope.delete(varName);
      }
    }

    // 2. Detect sinks
    if (ts.isCallExpression(node)) {
      let methodName = "";
      let isConsole = false;
      let isDatabase = false;
      let isShell = false;

      if (ts.isPropertyAccessExpression(node.expression)) {
        methodName = node.expression.name.text.toLowerCase();
        const calleeObj = node.expression.expression.getText(sourceFile);

        if (calleeObj === "console" && CONSOLE_METHODS.has(methodName)) {
          isConsole = true;
        } else if (
          DATABASE_SINK_METHODS.has(methodName) ||
          calleeObj.includes("db") ||
          calleeObj.includes("prisma") ||
          calleeObj.includes("connection")
        ) {
          if (DATABASE_SINK_METHODS.has(methodName)) {
            isDatabase = true;
          }
        } else if (SHELL_SINK_METHODS.has(methodName) || calleeObj.includes("child_process")) {
          if (SHELL_SINK_METHODS.has(methodName)) {
            isShell = true;
          }
        }
      }

      // Check Database Sink: Dynamic query construction with unescaped taint
      if (isDatabase && node.arguments.length > 0) {
        const queryArg = node.arguments[0]!;
        const isDynamic =
          ts.isTemplateExpression(queryArg) ||
          (ts.isBinaryExpression(queryArg) &&
            queryArg.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
          (ts.isIdentifier(queryArg) && taintScope.has(queryArg.text));

        if (isDynamic) {
          const taint = evaluateTaint(queryArg, sourceFile, taintScope);
          if (taint) {
            const startPos = node.getStart(sourceFile);
            const line = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
            violations.push({
              line,
              text: getLineText(startPos),
              reason: `Unescaped taint flow (${taint.sourceText}) into dynamic database query sink`,
              severity: "CRITICAL",
              ruleId: "SECUREFLOW-010",
              custom: true,
            });
          }
        }
      }

      // Check Shell Sink: Command injection taint
      if (isShell && node.arguments.length > 0) {
        const cmdArg = node.arguments[0]!;
        const taint = evaluateTaint(cmdArg, sourceFile, taintScope);
        if (taint) {
          const startPos = node.getStart(sourceFile);
          const line = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
          violations.push({
            line,
            text: getLineText(startPos),
            reason: `Unescaped taint flow (${taint.sourceText}) into shell execution sink`,
            severity: "CRITICAL",
            ruleId: "SECUREFLOW-012",
            custom: true,
          });
        }
      }

      // Check Console Sink: Credential / secret variable logged via template or variable
      if (isConsole) {
        for (const arg of node.arguments) {
          const isTemplateOrConcat =
            ts.isTemplateExpression(arg) ||
            (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken);
          const isTaintedVar = ts.isIdentifier(arg) && taintScope.has(arg.text);

          if (isTemplateOrConcat || isTaintedVar) {
            const taint = evaluateTaint(arg, sourceFile, taintScope);
            if (taint) {
              const startPos = node.getStart(sourceFile);
              const line = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
              violations.push({
                line,
                text: getLineText(startPos),
                reason: `Semantic taint: ${taint.type === "env" ? "environment variable" : "credential identifier"} (${taint.sourceText}) passed to console logging`,
                severity: "HIGH",
                ruleId: "SECUREFLOW-011",
                custom: true,
              });
              break; // One violation per console statement is sufficient
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}
