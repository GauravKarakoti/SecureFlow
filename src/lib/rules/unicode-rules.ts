/**
 * Deterministic Hidden Unicode (Trojan Source) and Homoglyph Security Rules (#2089)
 *
 * Detects invisible, deceptive, or malicious Unicode characters in added code lines:
 * 1. Bidirectional Override and Isolate characters (CVE-2021-42574 Trojan Source)
 *    e.g. U+202A..U+202E, U+2066..U+2069, U+200E, U+200F, U+061C
 * 2. Zero-Width and Invisible characters (CVE-2021-42694)
 *    e.g. U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ), U+FEFF (BOM inside line), U+2060 (WJ)
 * 3. Mixed-Script / Homoglyph Identifiers (Look-alike Cyrillic/Greek letters in Latin code)
 *    e.g. Cyrillic 'а', 'е', 'о', 'р', 'с', 'у', 'х', 'і', 'ј' embedded within ASCII identifiers
 *
 * Provides documented allow-rules to skip legitimately non-Latin files
 * (documentation, translation, localization, i18n/l10n catalogs, markdown/txt).
 */

import { computeDynamicFingerprint, computeFingerprint } from "@/lib/armor/fingerprint";
import { parseUnifiedPatch, addedLines } from "@/lib/armor/diff";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";

export const UNICODE_RULE_IDS = {
  BIDI_CONTROL: "SEC_UNICODE_BIDI_CONTROL",
  ZERO_WIDTH: "SEC_UNICODE_ZERO_WIDTH",
  HOMOGLYPH_IDENTIFIER: "SEC_UNICODE_HOMOGLYPH_IDENTIFIER",
} as const;

export type UnicodeRuleId = (typeof UNICODE_RULE_IDS)[keyof typeof UNICODE_RULE_IDS];

/** Bidirectional text directionality override and isolate characters (Trojan Source). */
export const BIDI_CODEPOINTS: ReadonlyMap<number, string> = new Map([
  [0x202a, "Left-to-Right Embedding (LRE)"],
  [0x202b, "Right-to-Left Embedding (RLE)"],
  [0x202c, "Pop Directional Formatting (PDF)"],
  [0x202d, "Left-to-Right Override (LRO)"],
  [0x202e, "Right-to-Left Override (RLO)"],
  [0x2066, "Left-to-Right Isolate (LRI)"],
  [0x2067, "Right-to-Left Isolate (RLI)"],
  [0x2068, "First Strong Isolate (FSI)"],
  [0x2069, "Pop Directional Isolate (PDI)"],
  [0x200e, "Left-to-Right Mark (LRM)"],
  [0x200f, "Right-to-Left Mark (RLM)"],
  [0x061c, "Arabic Letter Mark (ALM)"],
]);

/** Zero-width and invisible formatting characters. */
export const ZERO_WIDTH_CODEPOINTS: ReadonlyMap<number, string> = new Map([
  [0x200b, "Zero-Width Space (ZWSP)"],
  [0x200c, "Zero-Width Non-Joiner (ZWNJ)"],
  [0x200d, "Zero-Width Joiner (ZWJ)"],
  [0x2060, "Word Joiner (WJ)"],
  [0xfeff, "Zero-Width No-Break Space / Byte Order Mark (ZWNBSP)"],
  [0x00ad, "Soft Hyphen (SHY)"],
  [0x180e, "Mongolian Vowel Separator (MVS)"],
  [0x2000, "En Quad"],
  [0x2001, "Em Quad"],
  [0x2002, "En Space"],
  [0x2003, "Em Space"],
  [0x2004, "Three-Per-Em Space"],
  [0x2005, "Four-Per-Em Space"],
  [0x2006, "Six-Per-Em Space"],
  [0x2007, "Figure Space"],
  [0x2008, "Punctuation Space"],
  [0x2009, "Thin Space"],
  [0x200a, "Hair Space"],
  [0x202f, "Narrow No-Break Space (NNBSP)"],
  [0x205f, "Medium Mathematical Space (MMSP)"],
  [0x3000, "Ideographic Space"],
]);

/**
 * Common look-alike Cyrillic & Greek homoglyphs mapped to ASCII counterparts.
 * These characters visually mimic ASCII Latin letters in source identifiers.
 */
export const HOMOGLYPH_MAP: ReadonlyMap<number, { ascii: string; script: string }> = new Map([
  // Cyrillic small lookalikes
  [0x0430, { ascii: "a", script: "Cyrillic" }], // а
  [0x0441, { ascii: "c", script: "Cyrillic" }], // с
  [0x0435, { ascii: "e", script: "Cyrillic" }], // е
  [0x0456, { ascii: "i", script: "Cyrillic" }], // і
  [0x0458, { ascii: "j", script: "Cyrillic" }], // ј
  [0x043e, { ascii: "o", script: "Cyrillic" }], // о
  [0x0440, { ascii: "p", script: "Cyrillic" }], // р
  [0x0455, { ascii: "s", script: "Cyrillic" }], // ѕ
  [0x0445, { ascii: "x", script: "Cyrillic" }], // х
  [0x0443, { ascii: "y", script: "Cyrillic" }], // у

  // Cyrillic capital lookalikes
  [0x0410, { ascii: "A", script: "Cyrillic" }], // А
  [0x0412, { ascii: "B", script: "Cyrillic" }], // В
  [0x0421, { ascii: "C", script: "Cyrillic" }], // С
  [0x0415, { ascii: "E", script: "Cyrillic" }], // Е
  [0x041d, { ascii: "H", script: "Cyrillic" }], // Н
  [0x0406, { ascii: "I", script: "Cyrillic" }], // І
  [0x0408, { ascii: "J", script: "Cyrillic" }], // Ј
  [0x041a, { ascii: "K", script: "Cyrillic" }], // К
  [0x041c, { ascii: "M", script: "Cyrillic" }], // М
  [0x041e, { ascii: "O", script: "Cyrillic" }], // О
  [0x0420, { ascii: "P", script: "Cyrillic" }], // Р
  [0x0422, { ascii: "T", script: "Cyrillic" }], // Т
  [0x0425, { ascii: "X", script: "Cyrillic" }], // Х
  [0x0423, { ascii: "Y", script: "Cyrillic" }], // Ү

  // Greek lookalikes
  [0x03b1, { ascii: "a", script: "Greek" }], // α
  [0x03bf, { ascii: "o", script: "Greek" }], // ο
  [0x03c1, { ascii: "p", script: "Greek" }], // ρ
  [0x03bd, { ascii: "v", script: "Greek" }], // ν
  [0x0391, { ascii: "A", script: "Greek" }], // Α
  [0x0392, { ascii: "B", script: "Greek" }], // Β
  [0x0395, { ascii: "E", script: "Greek" }], // Ε
  [0x0397, { ascii: "H", script: "Greek" }], // Η
  [0x0399, { ascii: "I", script: "Greek" }], // Ι
  [0x039a, { ascii: "K", script: "Greek" }], // Κ
  [0x039c, { ascii: "M", script: "Greek" }], // Μ
  [0x039d, { ascii: "N", script: "Greek" }], // Ν
  [0x039f, { ascii: "O", script: "Greek" }], // Ο
  [0x03a1, { ascii: "P", script: "Greek" }], // Ρ
  [0x03a4, { ascii: "T", script: "Greek" }], // Τ
  [0x03a7, { ascii: "X", script: "Greek" }], // Χ
  [0x03a5, { ascii: "Y", script: "Greek" }], // Υ
  [0x0396, { ascii: "Z", script: "Greek" }], // Ζ
]);

/** Format a code point number as a standard hexadecimal U+XXXX string. */
export function formatCodePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

export interface UnicodeRuleOptions {
  repositoryId?: string;
  disabledRules?: string[];
  enabled?: boolean;
  /** Custom glob/path patterns to treat as legitimately non-Latin (skip flagging). */
  allowPatterns?: string[];
}

/** Default path patterns legitimately expected to contain non-Latin or localized text. */
export const DEFAULT_NON_LATIN_ALLOW_PATTERNS: readonly string[] = [
  // Documentation files
  "docs/**",
  "doc/**",
  "documentation/**",
  "*.md",
  "*.mdx",
  "*.txt",
  "*.rst",
  "*.adoc",
  "LICENSE*",
  "NOTICE*",

  // Localization / internationalization catalogs
  "locales/**",
  "locale/**",
  "i18n/**",
  "l10n/**",
  "translations/**",
  "lang/**",
  "languages/**",
  "po/**",
  "messages/**",
  "*.po",
  "*.pot",
  "*.mo",
  "*.strings",
  "*.xliff",
  "*.xlf",
];

/**
 * Checks if a given file path is legitimately non-Latin and should be skipped
 * from homoglyph and non-Latin character checks.
 */
export function isLegitimatelyNonLatinFile(
  filename: string,
  customAllowPatterns?: string[],
): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() || normalized;

  // 1. Direct file extensions for documentation / translations
  if (
    basename.endsWith(".md") ||
    basename.endsWith(".mdx") ||
    basename.endsWith(".txt") ||
    basename.endsWith(".rst") ||
    basename.endsWith(".adoc") ||
    basename.endsWith(".po") ||
    basename.endsWith(".pot") ||
    basename.endsWith(".mo") ||
    basename.endsWith(".strings") ||
    basename.endsWith(".xliff") ||
    basename.endsWith(".xlf") ||
    basename.startsWith("license") ||
    basename.startsWith("notice") ||
    basename.startsWith("changelog") ||
    basename.startsWith("readme")
  ) {
    return true;
  }

  // 2. Localization directory paths
  const parts = normalized.split("/");
  const dirParts = parts.slice(0, -1);
  const isL10nDir = dirParts.some((p) =>
    [
      "docs",
      "doc",
      "documentation",
      "locales",
      "locale",
      "i18n",
      "l10n",
      "translations",
      "lang",
      "languages",
      "po",
      "messages",
    ].includes(p),
  );
  if (isL10nDir) {
    return true;
  }

  // 3. Common locale JSON files: e.g. en.json, zh-CN.json, ru.json, fr.json
  if (
    /^(?:[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?)\.(?:json|ya?ml|properties)$/i.test(basename) &&
    (dirParts.includes("lang") ||
      dirParts.includes("locale") ||
      dirParts.includes("locales") ||
      dirParts.includes("i18n") ||
      dirParts.includes("translations"))
  ) {
    return true;
  }

  // 4. Custom allow patterns
  if (customAllowPatterns && customAllowPatterns.length > 0) {
    for (const pat of customAllowPatterns) {
      const cleanPat = pat.replace(/\\/g, "/").toLowerCase();
      if (cleanPat.endsWith("/**")) {
        const prefix = cleanPat.slice(0, -3);
        if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) return true;
      } else if (cleanPat.startsWith("*.")) {
        const ext = cleanPat.slice(1);
        if (normalized.endsWith(ext)) return true;
      } else if (normalized.includes(cleanPat)) {
        return true;
      }
    }
  }

  return false;
}

export interface DetectedUnicodeFinding {
  ruleId: UnicodeRuleId;
  severity: Severity;
  type: string;
  codePoints: string[];
  names: string[];
  description: string;
  oneLineFix: string;
  lineNumber: number;
  lineSnippet: string;
}

/**
 * Inspects a single source line for invisible and deceptive Unicode characters.
 */
export function checkLineForUnicodeAnomalies(
  line: string,
  lineNumber: number,
  isAllowedNonLatin: boolean,
): DetectedUnicodeFinding[] {
  const findings: DetectedUnicodeFinding[] = [];

  // Check 1: Bidirectional control characters (Always flagged, even in text, as bidi override in code is dangerous)
  const bidiFound: Array<{ cp: number; name: string }> = [];
  for (const char of line) {
    const cp = char.codePointAt(0);
    if (cp !== undefined && BIDI_CODEPOINTS.has(cp)) {
      bidiFound.push({ cp, name: BIDI_CODEPOINTS.get(cp)! });
    }
  }

  if (bidiFound.length > 0) {
    const uniqueCps = Array.from(new Set(bidiFound.map((b) => formatCodePoint(b.cp))));
    const uniqueNames = Array.from(new Set(bidiFound.map((b) => b.name)));
    findings.push({
      ruleId: UNICODE_RULE_IDS.BIDI_CONTROL,
      severity: "HIGH",
      type: "Trojan Source (Bidi Override)",
      codePoints: uniqueCps,
      names: uniqueNames,
      description: `Bidirectional control character(s) detected [${uniqueCps.join(", ")}] (${uniqueNames.join(", ")}). These alter visual rendering order to conceal malicious logic (CVE-2021-42574 Trojan Source).`,
      oneLineFix: `Remove all bidirectional control characters (${uniqueCps.join(", ")}) and write unambiguous left-to-right code.`,
      lineNumber,
      lineSnippet: line,
    });
  }

  // Check 2: Zero-width and invisible characters
  // Exclude leading Byte Order Mark at line 1 index 0 if valid file encoding BOM, but flag ZWSP/ZWNBSP inside text/tokens.
  const zwFound: Array<{ cp: number; name: string }> = [];
  for (let idx = 0; idx < line.length; idx++) {
    const char = line[idx];
    const cp = char.codePointAt(0);
    if (cp !== undefined && ZERO_WIDTH_CODEPOINTS.has(cp)) {
      if (cp === 0xfeff && lineNumber === 1 && idx === 0) {
        // Safe file-level UTF-8 BOM
        continue;
      }
      zwFound.push({ cp, name: ZERO_WIDTH_CODEPOINTS.get(cp)! });
    }
  }

  if (zwFound.length > 0) {
    const uniqueCps = Array.from(new Set(zwFound.map((b) => formatCodePoint(b.cp))));
    const uniqueNames = Array.from(new Set(zwFound.map((b) => b.name)));
    findings.push({
      ruleId: UNICODE_RULE_IDS.ZERO_WIDTH,
      severity: "HIGH",
      type: "Invisible Character",
      codePoints: uniqueCps,
      names: uniqueNames,
      description: `Zero-width or invisible character(s) detected [${uniqueCps.join(", ")}] (${uniqueNames.join(", ")}). These invisible characters can alter string values or parser interpretation while remaining invisible to human reviewers (CVE-2021-42694).`,
      oneLineFix: `Remove zero-width character(s) [${uniqueCps.join(", ")}] from source code.`,
      lineNumber,
      lineSnippet: line,
    });
  }

  // Check 3: Mixed-script / Homoglyph identifiers
  // Only checked if file is NOT an allowed non-Latin file (e.g. documentation or localization)
  if (!isAllowedNonLatin) {
    // Scan identifier tokens: e.g. words composed of alphanumeric characters plus '_' or '$'
    const tokens = line.match(/[\p{L}\p{N}_$]+/gu) || [];
    const homoglyphsFound: Array<{ token: string; cp: number; ascii: string; script: string }> = [];

    for (const token of tokens) {
      let hasAscii = false;
      let hasNonAscii = false;
      const tokenHomoglyphs: Array<{ cp: number; ascii: string; script: string }> = [];

      for (const char of token) {
        const cp = char.codePointAt(0);
        if (cp === undefined) continue;

        if (cp < 0x80) {
          if (/[a-zA-Z]/.test(char)) {
            hasAscii = true;
          }
        } else {
          hasNonAscii = true;
          if (HOMOGLYPH_MAP.has(cp)) {
            tokenHomoglyphs.push({ cp, ...HOMOGLYPH_MAP.get(cp)! });
          }
        }
      }

      // Flag mixed-script tokens containing look-alikes mixed with ASCII
      if (hasAscii && hasNonAscii && tokenHomoglyphs.length > 0) {
        for (const h of tokenHomoglyphs) {
          homoglyphsFound.push({ token, ...h });
        }
      }
    }

    if (homoglyphsFound.length > 0) {
      const uniqueCps = Array.from(new Set(homoglyphsFound.map((h) => formatCodePoint(h.cp))));
      const uniqueDetails = Array.from(
        new Set(
          homoglyphsFound.map(
            (h) => `${formatCodePoint(h.cp)} (${h.script} look-alike for ASCII '${h.ascii}')`,
          ),
        ),
      );
      const uniqueTokens = Array.from(new Set(homoglyphsFound.map((h) => `'${h.token}'`)));

      findings.push({
        ruleId: UNICODE_RULE_IDS.HOMOGLYPH_IDENTIFIER,
        severity: "HIGH",
        type: "Homoglyph Identifier",
        codePoints: uniqueCps,
        names: uniqueDetails,
        description: `Mixed-script homoglyph character(s) detected [${uniqueCps.join(", ")}] in identifier(s) ${uniqueTokens.join(", ")}. Character details: ${uniqueDetails.join(", ")}. These mimic standard Latin letters to create deceptive duplicate variables or function calls.`,
        oneLineFix: `Replace deceptive homoglyphs [${uniqueCps.join(", ")}] with standard ASCII characters.`,
        lineNumber,
        lineSnippet: line,
      });
    }
  }

  return findings;
}

/**
 * Scans added lines in a single file change for Unicode and homoglyph attacks (#2089).
 * Accepts either `(fileChange, options)` or `(filename, patch, options)`.
 */
export function scanFileWithUnicodeRules(
  fileOrFilename: FileChange | string,
  optionsOrPatch?: UnicodeRuleOptions | string,
  maybeOptions?: UnicodeRuleOptions,
): ScanFinding[] {
  let file: FileChange;
  let options: UnicodeRuleOptions;

  if (typeof fileOrFilename === "string") {
    file = {
      filename: fileOrFilename,
      patch: typeof optionsOrPatch === "string" ? optionsOrPatch : "",
    };
    options = maybeOptions || {};
  } else {
    file = fileOrFilename;
    options = (typeof optionsOrPatch === "object" ? optionsOrPatch : maybeOptions) || {};
  }

  if (options.enabled === false) return [];
  if (!file.patch || !file.patch.trim()) return [];

  const disabledSet = new Set(options.disabledRules ?? []);
  const repositoryId = options.repositoryId || "default-repo";
  const isAllowedNonLatin = isLegitimatelyNonLatinFile(file.filename, options.allowPatterns);

  if (
    disabledSet.has(UNICODE_RULE_IDS.BIDI_CONTROL) &&
    disabledSet.has(UNICODE_RULE_IDS.ZERO_WIDTH) &&
    disabledSet.has(UNICODE_RULE_IDS.HOMOGLYPH_IDENTIFIER)
  ) {
    return [];
  }

  // Parse unified diff and isolate ONLY added lines
  let added: Array<{ number: number; content: string }> = [];
  if (file.patch.includes("@@")) {
    const parsed = parseUnifiedPatch(file.patch);
    added = addedLines(parsed);
  } else {
    const lines = file.patch.split(/\r?\n/);
    let lineNum = 1;
    for (const l of lines) {
      if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")) {
        continue;
      }
      if (l.startsWith("+")) {
        added.push({ number: lineNum, content: l.slice(1) });
        lineNum++;
      } else if (!l.startsWith("-")) {
        lineNum++;
      }
    }
  }

  const findings: ScanFinding[] = [];

  for (const item of added) {
    const anomalies = checkLineForUnicodeAnomalies(item.content, item.number, isAllowedNonLatin);

    for (const anomaly of anomalies) {
      if (disabledSet.has(anomaly.ruleId)) continue;

      const lineSnippet = anomaly.lineSnippet.trim();
      const baseHash = computeFingerprint(repositoryId, file.filename, anomaly.type, lineSnippet);
      const dynFp = computeDynamicFingerprint(
        repositoryId,
        file.filename,
        anomaly.type,
        lineSnippet,
      );

      findings.push({
        type: anomaly.type,
        severity: anomaly.severity,
        description: `[${anomaly.ruleId}] ${anomaly.description}`,
        fileLocation: file.filename,
        lineStart: anomaly.lineNumber,
        lineEnd: anomaly.lineNumber,
        codeSnippet: anomaly.lineSnippet,
        remediation: anomaly.oneLineFix,
        dynamicFingerprint: dynFp.fingerprint,
        fingerprint: baseHash,
        matchedSignatures: [anomaly.ruleId],
        confidence: "HIGH",
        confidenceReason: `Deterministic Unicode anomaly detected: ${anomaly.codePoints.join(", ")}`,
      });
    }
  }

  return findings;
}

/**
 * Runs deterministic Unicode and homoglyph security rules across all modified files (#2089).
 */
export function runUnicodeSecurityRules(
  files: FileChange[],
  options: UnicodeRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) return [];
  const findings: ScanFinding[] = [];

  for (const file of files) {
    const fileFindings = scanFileWithUnicodeRules(file, options);
    findings.push(...fileFindings);
  }

  return findings;
}
