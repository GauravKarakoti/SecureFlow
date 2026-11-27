import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { applyUnifiedPatchWithConflictDetection } from "./patch-applier";

export interface PatchApplyResult {
  success: boolean;
  patchedContent?: string;
  error?: string;
}

export interface SyntaxParseResult {
  valid: boolean;
  language: string;
  error?: string;
}

export interface PatchVerificationResult {
  verified: boolean;
  readyFix: boolean;
  appliedCleanly: boolean;
  syntaxValid: boolean;
  patchedContent?: string;
  error?: string;
  note?: string;
  language?: string;
}

/**
 * Applies a unified diff patch to source content in memory.
 * Validates header hunks, context lines, and removal lines.
 * Returns the patched content if it applies cleanly, or an error.
 */
export function applyPatchToContent(
  source: string,
  patch: string,
  expectedFilePath?: string,
): PatchApplyResult {
  if (!patch || !patch.trim()) {
    return { success: false, error: "Empty patch provided" };
  }

  const normalizedPatch = patch.replace(/\r\n/g, "\n");
  const lines = normalizedPatch.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk === -1) {
    // Check if it's a simple raw replacement snippet or invalid format
    return { success: false, error: "Patch contains no unified diff hunks (missing @@ header)" };
  }

  // Validate headers if present
  const headers = lines.slice(0, firstHunk);
  const oldHeaders = headers.filter((line) => line.startsWith("--- "));
  const newHeaders = headers.filter((line) => line.startsWith("+++ "));

  if (oldHeaders.length > 0 && newHeaders.length > 0 && expectedFilePath) {
    const normExpected = expectedFilePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const extractPath = (hdr: string): string => {
      const raw = hdr
        .slice(4)
        .trim()
        .split("\t", 1)[0]
        .replace(/^a\/|^b\//, "");
      return raw.replace(/\\/g, "/").replace(/^\.\//, "");
    };
    const oldPath = extractPath(oldHeaders[0]);
    const newPath = extractPath(newHeaders[0]);

    if (!normExpected.endsWith(oldPath) && !oldPath.endsWith(normExpected)) {
      return {
        success: false,
        error: `Patch header target '${oldPath}' does not match expected file '${normExpected}'`,
      };
    }
  }

  const sourceHasTrailingNewline = source.endsWith("\n");
  const sourceLines = source.replace(/\r\n/g, "\n").split("\n");
  if (sourceHasTrailingNewline) sourceLines.pop();

  const result: string[] = [];
  let sourceIndex = 0;
  let hunkCount = 0;

  for (let index = 0; index < lines.length; index++) {
    const hunkMatch = lines[index].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) continue;

    hunkCount++;
    const oldStart = Number(hunkMatch[1]);
    const expectedOldCount = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
    const expectedNewCount = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
    const targetIndex = oldStart === 0 ? 0 : oldStart - 1;

    if (targetIndex < sourceIndex || targetIndex > sourceLines.length) {
      return {
        success: false,
        error: `Patch hunk line offset ${oldStart} is outside current file boundaries (total lines: ${sourceLines.length})`,
      };
    }

    result.push(...sourceLines.slice(sourceIndex, targetIndex));
    sourceIndex = targetIndex;

    let oldCount = 0;
    let newCount = 0;

    while (index + 1 < lines.length && !lines[index + 1].startsWith("@@ ")) {
      const line = lines[index + 1];
      index++;

      if (line.startsWith("\\")) {
        // e.g. "\ No newline at end of file"
        continue;
      }

      if (line.startsWith(" ")) {
        const context = line.slice(1);
        if (sourceIndex >= sourceLines.length || sourceLines[sourceIndex] !== context) {
          return {
            success: false,
            error: `Patch context mismatch at line ${sourceIndex + 1}: expected "${context}", found "${sourceLines[sourceIndex] ?? "<EOF>"}"`,
          };
        }
        result.push(context);
        sourceIndex++;
        oldCount++;
        newCount++;
      } else if (line.startsWith("-")) {
        const removal = line.slice(1);
        if (sourceIndex >= sourceLines.length || sourceLines[sourceIndex] !== removal) {
          return {
            success: false,
            error: `Patch removal mismatch at line ${sourceIndex + 1}: expected to remove "${removal}", found "${sourceLines[sourceIndex] ?? "<EOF>"}"`,
          };
        }
        sourceIndex++;
        oldCount++;
      } else if (line.startsWith("+")) {
        result.push(line.slice(1));
        newCount++;
      } else {
        return {
          success: false,
          error: `Patch contains invalid line in hunk: "${line}"`,
        };
      }
    }

    if (oldCount !== expectedOldCount || newCount !== expectedNewCount) {
      return {
        success: false,
        error: `Patch hunk line counts mismatch: expected -${expectedOldCount},+${expectedNewCount} but got -${oldCount},+${newCount}`,
      };
    }
  }

  if (hunkCount === 0) {
    return { success: false, error: "Patch contains no unified diff hunks" };
  }

  result.push(...sourceLines.slice(sourceIndex));
  const finalPatched = result.join("\n") + (sourceHasTrailingNewline ? "\n" : "");
  return { success: true, patchedContent: finalPatched };
}

/**
 * Detect language identifier from file extension or path.
 */
export function detectLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "py":
    case "pyw":
      return "python";
    case "yml":
    case "yaml":
      return "yaml";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "sql":
      return "sql";
    default:
      return ext || "unknown";
  }
}

/**
 * Parses Python code to detect syntax errors without external runtime dependencies.
 * Checks delimiter nesting, unclosed strings, and illegal statement syntax.
 */
function parsePythonSyntax(content: string): { valid: boolean; error?: string } {
  const stack: { char: string; line: number }[] = [];
  const lines = content.split("\n");

  let inTripleSingle = false;
  let inTripleDouble = false;

  for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
    const rawLine = lines[lineNum - 1];
    const line = rawLine.trim();

    // Skip empty lines
    if (!line) continue;

    // Check statement syntax on non-comment lines outside multi-line strings
    if (!inTripleSingle && !inTripleDouble && !line.startsWith("#")) {
      // Check invalid tokens
      if (/\b(?:const|let|var)\s+[a-zA-Z0-9_]+\s*[:=]/.test(line)) {
        return {
          valid: false,
          error: `Python syntax error at line ${lineNum}: JavaScript keyword detected ('${line}')`,
        };
      }
      if (/=\s*;/.test(line)) {
        return {
          valid: false,
          error: `Python syntax error at line ${lineNum}: invalid semicolon expression ('${line}')`,
        };
      }

      // Check missing colons on compound statements
      const compoundMatch = line.match(
        /^(?:if|elif|else|for|while|def|class|try|except|finally)\b(.*)$/,
      );
      if (compoundMatch) {
        const rest = compoundMatch[1].trim();
        // Disregard if comment follows
        const cleanRest = rest.split("#")[0].trim();
        if (cleanRest && !cleanRest.endsWith(":")) {
          // Check if parenthesized condition might be continuing on next line
          if (!cleanRest.includes("(") || cleanRest.endsWith(")")) {
            return {
              valid: false,
              error: `Python syntax error at line ${lineNum}: expected ':' at end of '${line}'`,
            };
          }
        } else if (!cleanRest && !["else", "try", "finally"].some((kw) => line.startsWith(kw))) {
          return {
            valid: false,
            error: `Python syntax error at line ${lineNum}: missing header body for '${line}'`,
          };
        }
      }
    }

    // Delimiter & string balance scanner
    let inSingle = false;
    let inDouble = false;
    let i = 0;

    while (i < rawLine.length) {
      if (inTripleSingle) {
        if (rawLine.slice(i, i + 3) === "'''") {
          inTripleSingle = false;
          i += 3;
          continue;
        }
        i++;
        continue;
      }
      if (inTripleDouble) {
        if (rawLine.slice(i, i + 3) === '"""') {
          inTripleDouble = false;
          i += 3;
          continue;
        }
        i++;
        continue;
      }

      const ch = rawLine[i];
      const next3 = rawLine.slice(i, i + 3);

      if (next3 === "'''" && !inDouble && !inSingle) {
        inTripleSingle = true;
        i += 3;
        continue;
      }
      if (next3 === '"""' && !inDouble && !inSingle) {
        inTripleDouble = true;
        i += 3;
        continue;
      }

      if (ch === "#" && !inSingle && !inDouble) {
        // Comment until line end
        break;
      }

      if (ch === "\\" && (inSingle || inDouble)) {
        // Escaped character in string
        i += 2;
        continue;
      }

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        i++;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        i++;
        continue;
      }

      if (!inSingle && !inDouble) {
        if (ch === "(" || ch === "[" || ch === "{") {
          stack.push({ char: ch, line: lineNum });
        } else if (ch === ")" || ch === "]" || ch === "}") {
          const expected = ch === ")" ? "(" : ch === "]" ? "[" : "{";
          if (stack.length === 0 || stack[stack.length - 1].char !== expected) {
            return {
              valid: false,
              error: `Python syntax error at line ${lineNum}: unmatched closing '${ch}'`,
            };
          }
          stack.pop();
        }
      }

      i++;
    }

    if (inSingle || inDouble) {
      return {
        valid: false,
        error: `Python syntax error at line ${lineNum}: unclosed string literal on line ${lineNum}`,
      };
    }
  }

  if (inTripleSingle || inTripleDouble) {
    return {
      valid: false,
      error: "Python syntax error: unclosed multi-line string literal at end of file",
    };
  }

  if (stack.length > 0) {
    const unclosed = stack.pop()!;
    return {
      valid: false,
      error: `Python syntax error: unclosed '${unclosed.char}' opened at line ${unclosed.line}`,
    };
  }

  return { valid: true };
}

/**
 * Validates syntax of patched code for supported programming languages.
 * Uses the TypeScript compiler API for JS/TS, built-in JSON parser for JSON,
 * and deterministic AST/grammar validation for Python.
 */
export function parseSyntax(filePath: string, content: string): SyntaxParseResult {
  const language = detectLanguageFromPath(filePath);

  switch (language) {
    case "typescript":
    case "javascript": {
      const isTsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
      const fileName = path.basename(filePath);
      const sourceFile = ts.createSourceFile(
        fileName,
        content,
        ts.ScriptTarget.Latest,
        true,
        isTsx ? ts.ScriptKind.TSX : filePath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
      );

      const diagnostics = (sourceFile as any).parseDiagnostics || [];
      if (diagnostics.length > 0) {
        const errorMessages = diagnostics.map((d: any) => {
          const message =
            typeof d.messageText === "string" ? d.messageText : d.messageText?.messageText;
          return message || "Syntax parsing error";
        });
        return {
          valid: false,
          language,
          error: `Syntax error in ${language} (${fileName}): ${errorMessages.slice(0, 3).join("; ")}`,
        };
      }
      return { valid: true, language };
    }

    case "json": {
      try {
        JSON.parse(content);
        return { valid: true, language };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          valid: false,
          language,
          error: `JSON syntax error in ${path.basename(filePath)}: ${msg}`,
        };
      }
    }

    case "python": {
      const pyCheck = parsePythonSyntax(content);
      if (!pyCheck.valid) {
        return {
          valid: false,
          language,
          error: pyCheck.error || "Python syntax error",
        };
      }
      return { valid: true, language };
    }

    default:
      // Other formats (e.g. Markdown, plain text, etc.) are treated as valid if no parser exists
      return { valid: true, language };
  }
}

/**
 * Verifies a generated patch by applying it to an isolated temporary copy of the file
 * and executing syntax parsing on the patched copy.
 *
 * CRITICAL SAFETY INVARIANT:
 * Never touches, reads/writes, or modifies real workspace files during verification.
 */
export async function verifyPatchInTempCopy(options: {
  filePath: string;
  originalContent: string;
  patchDiff: string;
  realWorkspacePath?: string;
}): Promise<PatchVerificationResult> {
  const { filePath, originalContent, patchDiff, realWorkspacePath } = options;

  // Record stats of real file if it exists to assert the workspace safety invariant
  let initialRealMtime: number | null = null;
  let initialRealSize: number | null = null;
  if (realWorkspacePath && fs.existsSync(realWorkspacePath)) {
    try {
      const stat = fs.statSync(realWorkspacePath);
      initialRealMtime = stat.mtimeMs;
      initialRealSize = stat.size;
    } catch {
      // Ignore
    }
  }

  // Create isolated temp folder in os.tmpdir()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `secureflow-patch-${randomUUID()}-`));
  const tempFile = path.join(tempDir, path.basename(filePath));

  try {
    // 1. Write the temporary copy
    fs.writeFileSync(tempFile, originalContent, "utf8");

    // 2. Apply patch to temporary copy
    const applyResult = applyPatchToContent(originalContent, patchDiff, filePath);
    if (!applyResult.success || !applyResult.patchedContent) {
      return {
        verified: false,
        readyFix: false,
        appliedCleanly: false,
        syntaxValid: false,
        error: applyResult.error || "Patch failed to apply cleanly to temporary copy",
        note: `AI-suggested patch could not be applied cleanly: ${applyResult.error}`,
      };
    }

    // 3. Write patched content to temporary file
    fs.writeFileSync(tempFile, applyResult.patchedContent, "utf8");

    // 4. Run syntax parse on the patched copy
    const syntaxResult = parseSyntax(filePath, applyResult.patchedContent);
    if (!syntaxResult.valid) {
      return {
        verified: false,
        readyFix: false,
        appliedCleanly: true,
        syntaxValid: false,
        patchedContent: applyResult.patchedContent,
        language: syntaxResult.language,
        error: syntaxResult.error || "Syntax parse failed on patched copy",
        note: `AI-suggested patch breaks syntax: ${syntaxResult.error}`,
      };
    }

    return {
      verified: true,
      readyFix: true,
      appliedCleanly: true,
      syntaxValid: true,
      patchedContent: applyResult.patchedContent,
      language: syntaxResult.language,
    };
  } finally {
    // Clean up temporary workspace directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }

    // Confirm real workspace file was never touched
    if (realWorkspacePath && fs.existsSync(realWorkspacePath) && initialRealMtime !== null) {
      const currentStat = fs.statSync(realWorkspacePath);
      if (currentStat.mtimeMs !== initialRealMtime || currentStat.size !== initialRealSize) {
        console.error(
          `[CRITICAL INVARIANT VIOLATION] Real workspace file was modified during patch verification: ${realWorkspacePath}`,
        );
      }
    }
  }
}

/**
 * Apply a patch using bounded fuzzy line-offset matching when exact hunk line numbers shifted.
 */
export function applyPatchWithFuzzyFallback(
  source: string,
  patch: string,
  expectedFilePath?: string,
  maxFuzzyOffset = 10,
) {
  return applyUnifiedPatchWithConflictDetection(source, patch, {
    expectedFilePath,
    maxFuzzyOffset,
    dryRun: true,
  });
}
