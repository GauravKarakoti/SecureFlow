/**
 * QNX 8.0 build provenance checks (#2212).
 *
 * Finds QNX buildfiles, toolchain scripts, makefiles, CMake files and CI jobs,
 * then reports builds that cannot be reproduced (no tool version, no target
 * architecture) and credentials written into them. Files are only read.
 *
 * References:
 * - qcc -V [[compiler/]version,][target]:
 *   https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/q/qcc.html
 * - buildfile `virtual` attribute and its default:
 *   https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.building/topic/buildfiles/nto_bootstrap.html
 * - mkqnximage --type / --arch:
 *   https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mkqnximage.html
 * - qnxsoftwarecenter_clt package_id[/package_version], -myqnx.password:
 *   https://www.qnx.com/developers/docs/qsc/com.qnx.doc.qsc.user_guide/topic/commandline_qsc.html
 */

import { KNOWN_SECRET_RULES, REDACTION_PLACEHOLDER, maskSecrets } from "./secret-masker.js";
import type { Severity, Violation } from "./scanner.js";

const DOC_URL =
  "https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/qnx-build-provenance.md";

export interface QnxBuildRule {
  id: string;
  title: string;
  severity: Severity;
  guidance: string;
}

const rule = (id: string, severity: Severity, title: string, guidance: string): QnxBuildRule => ({
  id,
  severity,
  title,
  guidance,
});

export const QNX_BUILD_RULES = {
  compilerVersion: rule(
    "QNX-BUILD-001",
    "LOW",
    "qcc target selected without a compiler version",
    "Pin the version, for example -V<version>,gcc_ntox86_64 using a version listed by qcc -V",
  ),
  targetArch: rule(
    "QNX-BUILD-002",
    "MEDIUM",
    "Compiler invoked without a target architecture",
    "Pass -V<version>,<target>, for example a gcc_ntox86_64 or gcc_ntoaarch64le target",
  ),
  packageVersion: rule(
    "QNX-BUILD-003",
    "MEDIUM",
    "QNX Software Center install without a package version",
    "Use package_id/package_version",
  ),
  imageArch: rule(
    "QNX-BUILD-004",
    "MEDIUM",
    "Bootable buildfile does not name the target architecture",
    "Add [virtual=x86_64,...] or [virtual=aarch64le,...] to the bootstrap section",
  ),
  vmArch: rule(
    "QNX-BUILD-005",
    "LOW",
    "mkqnximage virtual target created without --arch",
    "Add --arch=x86_64 or --arch=aarch64le",
  ),
  commandCredential: rule(
    "QNX-SECRET-001",
    "HIGH",
    "Password or license key written on a command line",
    "Read it from a CI secret, or from a protected options file passed as @file",
  ),
  privateKey: rule(
    "QNX-SECRET-002",
    "CRITICAL",
    "Private key embedded in a build file",
    "Remove the key, rotate it and provision it on the target at deploy time",
  ),
  literalSecret: rule(
    "QNX-SECRET-003",
    "HIGH",
    "Credential value hardcoded in a build file",
    "Move the value to a secret store and rotate it",
  ),
  shadowHash: rule(
    "QNX-SECRET-004",
    "HIGH",
    "Password hash embedded in an image shadow file",
    "Provision accounts at deploy time instead of committing hashes",
  ),
} as const;

export type QnxBuildFileKind = "buildfile" | "makefile" | "script" | "cmake" | "ci";

const QNX_TOOLS =
  /(?<![\w-])(?:qcc|q\+\+|mkifs|mkqnximage|qnxsoftwarecenter_clt|qnxsdp-env)(?![\w-])/;

const BUILDFILE_CONTENT =
  /^[ \t]*\[[^[\]\n]*(?:virtual=|\+script|perms=|uid=)|\.bootstrap[ \t]*=[ \t]*\{|\bprocnto(?:-[\w-]+)?\b/m;

/** Which kind of QNX build input a file is, or null when it is not one. */
export function classifyQnxBuildFile(filePath: string, content: string): QnxBuildFileKind | null {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").pop() ?? normalized;

  if (/\.(?:build|bld)$/.test(name)) {
    return BUILDFILE_CONTENT.test(content) ? "buildfile" : null;
  }
  if (/^(?:gnu)?makefile$|\.mk$/.test(name)) {
    return QNX_TOOLS.test(content) || /\bq(?:config|targets|rules)\.mk\b/.test(content)
      ? "makefile"
      : null;
  }
  if (/\.(?:sh|bash|zsh|bat|cmd|ps1)$|^dockerfile(?:\..+)?$/.test(name)) {
    return QNX_TOOLS.test(content) ? "script" : null;
  }
  if (name === "cmakelists.txt" || name.endsWith(".cmake")) {
    return QNX_TOOLS.test(content) || /CMAKE_SYSTEM_NAME\s+"?QNX\b/i.test(content) ? "cmake" : null;
  }
  if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(?:^|\/)\.gitlab-ci\.yml$/.test(normalized)) {
    return QNX_TOOLS.test(content) ? "ci" : null;
  }
  return null;
}

interface LogicalLine {
  text: string;
  /** Offset in `text` where each physical line starts, with its line number. */
  parts: Array<{ offset: number; line: number }>;
}

/** Removes a `#` comment (or a batch `::` / `REM` line) outside quotes. */
function stripComment(line: string): string {
  if (/^\s*(?:::|rem\s)/i.test(line)) return "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Joins lines continued with `\`, `^` (batch) or a backtick (PowerShell). */
function logicalLines(lines: string[], filePath: string): LogicalLine[] {
  const continuation = /\.(?:bat|cmd)$/i.test(filePath)
    ? /\^\s*$/
    : /\.ps1$/i.test(filePath)
      ? /`\s*$/
      : /\\\s*$/;
  const result: LogicalLine[] = [];
  let current: LogicalLine | null = null;

  lines.forEach((raw, index) => {
    const stripped = stripComment(raw);
    const continued = continuation.test(stripped);
    current ??= { text: "", parts: [] };
    current.parts.push({ offset: current.text.length, line: index + 1 });
    current.text += continued ? `${stripped.replace(continuation, "")} ` : stripped;
    if (!continued) {
      result.push(current);
      current = null;
    }
  });
  if (current) result.push(current);
  return result;
}

/** The physical line that holds `offset` of a logical line. */
function lineAt(logical: LogicalLine, offset: number): number {
  let low = 0;
  let high = logical.parts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (logical.parts[middle]!.offset <= offset) low = middle;
    else high = middle - 1;
  }
  return logical.parts[low]!.line;
}

const GENERIC_MASK_RULES = new Set(["quoted-secret-assignment", "bare-secret-assignment"]);
const COMMAND_RULES = new Set(["qnx-software-center-credential", "sshpass-password"]);

// A name followed by an operator and a value. Only the name is consumed, so
// `# old: api_key = "..."` yields both pairs, and long lines stay linear.
const ASSIGNMENT =
  /(?<![\w.-])([\w.-]+)(?=(["']?[ \t]*(?:[:?+]?=|:)[ \t]*(["']?))([^\s"'#;,]{4,})\3)/g;

const SECRET_NAME =
  /password|passwd|passphrase|secret|token|api[_-]?key|license[_-]?key|access[_-]?key/i;
const NOT_A_SECRET_NAME = /(?:file|path|dir|url|uri|name|id|ttl|expiry|type)$/i;
const NOT_A_SECRET_VALUE =
  /^(?:[$%@<{(~/\\*[]|\.{1,2}\/)|^(?:true|false|none|null|read|write|inherit|required|changeme|example|dummy)$|^(?:your|xxx)/i;

/** Where the hardcoded credential values sit in a line. */
function literalSecrets(line: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of line.matchAll(ASSIGNMENT)) {
    const [, name, operator, , value] = match as unknown as string[];
    if (
      !SECRET_NAME.test(name!) ||
      NOT_A_SECRET_NAME.test(name!) ||
      NOT_A_SECRET_VALUE.test(value!)
    ) {
      continue;
    }
    const start = match.index + name!.length + operator!.length;
    spans.push({ start, end: start + value!.length });
  }
  return spans;
}

const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;
const SHADOW_OPEN = /^[ \t]*(?:\[[^\]]*\][ \t]*)?"?[\w./-]*etc\/shadow"?[ \t]*=[ \t]*\{/;
const SHADOW_ENTRY = /^([ \t]*[A-Za-z_][\w.-]*:)([^:\s*!x][^:\s]{7,})(?=:)/;

/** The line as it may be shown in a report: no credential values. */
function maskBuildLine(line: string, inShadow: boolean): string {
  let masked = inShadow ? line.replace(SHADOW_ENTRY, `$1${REDACTION_PLACEHOLDER}`) : line;
  const key = PRIVATE_KEY_HEADER.exec(masked);
  if (key && masked.slice(key.index + key[0].length).trim()) {
    masked = `${masked.slice(0, key.index)}${key[0]}${REDACTION_PLACEHOLDER}`;
  }
  // Right to left so earlier offsets stay valid
  for (const { start, end } of literalSecrets(masked).reverse()) {
    masked = `${masked.slice(0, start)}${REDACTION_PLACEHOLDER}${masked.slice(end)}`;
  }
  return maskSecrets(masked).trim();
}

interface Finding {
  rule: QnxBuildRule;
  line: number;
}

function findCredentials(lines: string[], kind: QnxBuildFileKind): [Finding[], Set<number>] {
  const findings: Finding[] = [];
  const shadowLines = new Set<number>();
  let inShadow = false;

  // Raw lines on purpose: a secret in a comment is still exposed
  lines.forEach((text, index) => {
    const line = index + 1;

    if (inShadow) {
      if (/^[ \t]*\}/.test(text)) inShadow = false;
      else {
        shadowLines.add(line);
        if (SHADOW_ENTRY.test(text)) findings.push({ rule: QNX_BUILD_RULES.shadowHash, line });
      }
    } else if (kind === "buildfile" && SHADOW_OPEN.test(text)) {
      inShadow = true;
    }

    if (PRIVATE_KEY_HEADER.test(text)) {
      findings.push({ rule: QNX_BUILD_RULES.privateKey, line });
      return;
    }

    // search() ignores lastIndex, so the shared global patterns are safe to reuse
    const hits = KNOWN_SECRET_RULES.filter(
      (r) => !GENERIC_MASK_RULES.has(r.id) && text.search(r.pattern) !== -1,
    );

    if (hits.some((r) => COMMAND_RULES.has(r.id))) {
      findings.push({ rule: QNX_BUILD_RULES.commandCredential, line });
    } else if (hits.length > 0 || literalSecrets(text).length > 0) {
      findings.push({ rule: QNX_BUILD_RULES.literalSecret, line });
    }
  });

  return [findings, shadowLines];
}

const COMPILER = /(?<![\w-])(?:qcc|q\+\+)(?:\.exe)?(?![\w-])/;
const COMPILES = /\.(?:c|cc|cpp|cxx|s|o)(?![\w.])|(?<![\w-])-[co](?![\w-])/i;
const COMPILER_ASSIGNMENT =
  /^[ \t]*(?:export[ \t]+)?(?:CC|CXX|LD)[ \t]*[:?]?=[ \t]*["']?(?:qcc|q\+\+)/;
const VERSION_FLAG = /(?<![\w-])-V[ \t]*["']?([^\s"';&|)]*)/g;
const TARGET_ONLY = /^(?:[a-z]+_)?nto\w+$/;

function findProvenance(filePath: string, kind: QnxBuildFileKind, lines: string[]): Finding[] {
  const findings: Finding[] = [];
  const logical = logicalLines(lines, filePath);
  const code = logical.map((l) => l.text).join("\n");

  if (kind === "buildfile") {
    // Only images that boot need an architecture; data filesystems do not
    const boot = logical.find((l) => /\.bootstrap\b|\bprocnto(?:-[\w-]+)?\b/.test(l.text));
    const named = /\[[^[\]\n]*\bvirtual=(?:x86_64|aarch64le|\$)/.test(code);
    if (boot && !named) {
      findings.push({ rule: QNX_BUILD_RULES.imageArch, line: boot.parts[0]!.line });
    }
  }

  // A -V that names a target (or comes from a variable) anywhere in the file
  // may reach every compile through CFLAGS, so it silences the "no target" rule.
  const targetSomewhere = /(?<![\w-])-V[ \t]*["']?(?:[\w./]*,)?(?:\w{0,32}nto\w+|[$%])/.test(code);

  for (const entry of logical) {
    const { text } = entry;
    const report = (found: QnxBuildRule, offset: number) =>
      findings.push({ rule: found, line: lineAt(entry, offset) });
    const compiler = COMPILER.exec(text);

    for (const match of text.matchAll(VERSION_FLAG)) {
      if (TARGET_ONLY.test(match[1]!)) report(QNX_BUILD_RULES.compilerVersion, match.index);
    }

    const cmakeTarget = /CMAKE_(?:C|CXX)_COMPILER_TARGET\s+"?([^\s")]+)/.exec(text);
    if (cmakeTarget && TARGET_ONLY.test(cmakeTarget[1]!)) {
      report(QNX_BUILD_RULES.compilerVersion, cmakeTarget.index);
    }

    if (compiler && !targetSomewhere) {
      const command = text.slice(compiler.index);
      if (COMPILER_ASSIGNMENT.test(text) || COMPILES.test(command)) {
        report(QNX_BUILD_RULES.targetArch, compiler.index);
      }
    }

    const center = text.indexOf("qnxsoftwarecenter_clt");
    if (center !== -1) {
      for (const match of text.matchAll(/-install(?:Baseline|Package)[ \t=]+["']?([^\s"']+)/g)) {
        const unpinned = match[1]!
          .split(",")
          .some((id) => id && !id.includes("/") && !/[$%@]/.test(id));
        if (unpinned) report(QNX_BUILD_RULES.packageVersion, match.index);
      }
    }

    const image = /(?<![\w-])mkqnximage(?![\w-])/.exec(text);
    if (image && !/--arch[ =]/.test(text)) {
      if (/--type[ =](?:qemu|qvm)\b/.test(text.slice(image.index))) {
        report(QNX_BUILD_RULES.vmArch, image.index);
      }
    }
  }

  if (
    kind === "cmake" &&
    !targetSomewhere &&
    !/CMAKE_SYSTEM_PROCESSOR|CMAKE_(?:C|CXX)_COMPILER_TARGET/.test(code)
  ) {
    const entry = logical.find((l) => /CMAKE_SYSTEM_NAME\s+"?QNX\b/i.test(l.text));
    if (entry) findings.push({ rule: QNX_BUILD_RULES.targetArch, line: entry.parts[0]!.line });
  }

  return findings;
}

/** Scans one file. Returns nothing for files that are not QNX build inputs. */
export function scanQnxBuildFile(filePath: string, content: string): Violation[] {
  const kind = classifyQnxBuildFile(filePath, content);
  if (!kind) return [];

  const lines = content.split(/\r?\n/);
  const [credentials, shadowLines] = findCredentials(lines, kind);
  const found = new Map<string, Violation>();

  for (const { rule: matched, line } of [
    ...findProvenance(filePath, kind, lines),
    ...credentials,
  ]) {
    found.set(`${matched.id}:${line}`, {
      line,
      // Masked here because the text and JSON reporters print it unchanged
      text: maskBuildLine(lines[line - 1] ?? "", shadowLines.has(line)),
      reason: `${matched.title} (${matched.id}). Fix: ${matched.guidance}`,
      severity: matched.severity,
      ruleId: matched.id,
      custom: true,
      helpUrl: DOC_URL,
      guidance: matched.guidance,
    });
  }

  return [...found.values()].sort((a, b) => a.line - b.line);
}
