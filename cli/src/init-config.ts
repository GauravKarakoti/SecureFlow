import fs from "fs";
import path from "path";
import readline from "readline";
import {
  type GateLevel,
  type ValidationError,
  type FileValidationResult,
  type ConfigValidationReport,
  validateSecureFlowJson,
  validateSecureFlowIgnore,
} from "./contracts/config-schema.js";

export interface InitConfigOptions {
  targetDir?: string | undefined;
  blockOn?: GateLevel | undefined;
  ignorePaths?: string[] | undefined;
  languages?: string[] | undefined;
  force?: boolean | undefined;
  interactive?: boolean | undefined;
  rl?: readline.Interface | undefined;
  stdin?: NodeJS.ReadableStream | undefined;
  stdout?: NodeJS.WritableStream | undefined;
}

export interface InitConfigResult {
  jsonCreated: boolean;
  ignoreCreated: boolean;
  jsonSkipped: boolean;
  ignoreSkipped: boolean;
  jsonPath: string;
  ignorePath: string;
  messages: string[];
}

export interface ValidateConfigOptions {
  targetDir?: string | undefined;
  filePath?: string | undefined;
}

/**
 * Detects common programming languages and frameworks present in the repository root.
 */
export function detectRepoLanguages(dir: string): string[] {
  const languages: string[] = [];

  const hasFile = (filename: string) => fs.existsSync(path.join(dir, filename));
  const hasExt = (ext: string) => {
    try {
      const files = fs.readdirSync(dir);
      return files.some((f) => f.endsWith(ext));
    } catch {
      return false;
    }
  };

  if (hasFile("package.json") || hasFile("tsconfig.json")) {
    languages.push("typescript", "javascript");
  }
  if (
    hasFile("requirements.txt") ||
    hasFile("pyproject.toml") ||
    hasFile("setup.py") ||
    hasExt(".py")
  ) {
    languages.push("python");
  }
  if (hasFile("main.tf") || hasExt(".tf") || fs.existsSync(path.join(dir, "terraform"))) {
    languages.push("terraform");
  }
  if (hasFile("go.mod") || hasExt(".go")) {
    languages.push("go");
  }
  if (hasFile("Cargo.toml") || hasExt(".rs")) {
    languages.push("rust");
  }
  if (hasFile("pom.xml") || hasFile("build.gradle") || hasExt(".java")) {
    languages.push("java");
  }
  if (fs.existsSync(path.join(dir, "contracts")) || hasExt(".sol")) {
    languages.push("solidity");
  }

  return languages.length > 0 ? Array.from(new Set(languages)) : ["typescript", "javascript"];
}

/**
 * Generates `.secureflow.json` content with explanatory comments and sensible defaults.
 */
export function generateSecureFlowJson(options: {
  blockOn?: GateLevel;
  languages?: string[];
}): string {
  const blockOn = options.blockOn ?? "HIGH";
  const langs = (options.languages ?? ["typescript", "javascript"]).map((l) =>
    l.trim().toLowerCase(),
  );

  const policyScopes: Array<{
    paths: string[];
    enable?: string[];
    disable?: string[];
    comment?: string;
  }> = [];

  if (langs.includes("terraform")) {
    policyScopes.push({
      comment: "Infrastructure and cloud security policies for Terraform definitions",
      paths: ["terraform/**", "*.tf"],
      enable: ["Infrastructure Security", "Hardcoded Secrets"],
    });
  }

  if (langs.includes("typescript") || langs.includes("javascript") || langs.includes("frontend")) {
    policyScopes.push({
      comment: "Client-side and frontend application security checks",
      paths: ["src/**", "components/**"],
      enable: [
        "Cross-Site Scripting (XSS)",
        "Content Security Policy",
        "No Hardcoded Secrets",
      ],
    });
  }

  if (langs.includes("python")) {
    policyScopes.push({
      comment: "Backend server policies for Python services",
      paths: ["**/*.py"],
      enable: ["Injection Prevention", "No Hardcoded Secrets"],
    });
  }

  // Common testing scope
  policyScopes.push({
    comment: "Exclude production secret enforcement from mock credentials and tests",
    paths: ["tests/**", "**/*.test.*", "**/*.spec.*", "fixtures/**"],
    disable: ["No Hardcoded Secrets"],
  });

  const formattedScopes = policyScopes
    .map((scope) => {
      const lines = ["    {"];
      if (scope.comment) {
        lines.push(`      // ${scope.comment}`);
      }
      lines.push(`      "paths": ${JSON.stringify(scope.paths)},`);
      if (scope.enable) {
        lines.push(`      "enable": ${JSON.stringify(scope.enable)}`);
      } else if (scope.disable) {
        lines.push(`      "disable": ${JSON.stringify(scope.disable)}`);
      }
      lines.push("    }");
      return lines.join("\n");
    })
    .join(",\n");

  return [
    `// SecureFlow Repository Gate & Policy Configuration`,
    `// Documentation: https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/gate-configuration.md`,
    `{`,
    `  "$schema": "https://secureflow.dev/schema.json",`,
    `  "gate": {`,
    `    // Minimum severity threshold that blocks pull requests (CRITICAL, HIGH, MEDIUM, LOW, or NONE)`,
    `    "blockOn": "${blockOn}",`,
    `    // Severity threshold that flags pull requests for mandatory reviewer approval`,
    `    "reviewOn": "MEDIUM",`,
    `    // Path-scoped gate overrides evaluated before the global gate`,
    `    "paths": [`,
    `      { "glob": "infra/**", "blockOn": "HIGH" },`,
    `      { "glob": "tests/**", "blockOn": "NONE", "reviewOn": "NONE" }`,
    `    ]`,
    `  },`,
    `  // Monorepo directory-scoped policy rules: each file only receives policies allowed for its scope`,
    `  "policyScopes": [`,
    formattedScopes,
    `  ]`,
    `}`,
    "",
  ].join("\n");
}

/**
 * Generates `.secureflowignore` content with comments and sensible defaults.
 */
export function generateSecureFlowIgnore(options: { ignorePaths?: string[] }): string {
  const defaultPaths = [
    "node_modules/**: vendored third-party dependencies",
    "dist/**: compiled build artifacts",
    "build/**: build output directory",
    ".git/**: internal git version control metadata",
    "coverage/**: test execution coverage reports",
  ];

  const customPaths = (options.ignorePaths ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !defaultPaths.some((d) => d.startsWith(p)));

  const pathLines = [...defaultPaths, ...customPaths.map((p) => `${p}: custom repository ignore`)];

  return [
    `# SecureFlow Scanner Ignore Rules (.secureflowignore)`,
    `# Documentation: https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/gate-configuration.md`,
    ``,
    `[paths]`,
    ...pathLines.map((l) => `${l}`),
    ``,
    `[placeholders]`,
    `# Mock credentials and test tokens suppressed from alerts`,
    `# Syntax: <token-or-pattern> [reason=...] [expires=YYYY-MM-DD]`,
    `sk_test_mock_token_*: integration test fixture token`,
    `AKIA_FAKE_AWS_KEY_*: documentation and testing placeholder`,
    "",
  ].join("\n");
}

/**
 * Prompts user for confirmation to overwrite an existing file.
 */
export async function promptOverwrite(
  filename: string,
  rl?: readline.Interface,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  const readlineInterface =
    rl ||
    readline.createInterface({
      input,
      output,
    });
  const shouldClose = !rl;

  return new Promise<boolean>((resolve) => {
    readlineInterface.question(
      `⚠️  File '${filename}' already exists. Overwrite? (y/N): `,
      (answer) => {
        if (shouldClose) readlineInterface.close();
        const trimmed = answer.trim().toLowerCase();
        resolve(trimmed === "y" || trimmed === "yes");
      },
    );
  });
}

/**
 * Interactively prompts the user for configuration options.
 */
export async function promptConfigQuestions(
  defaults: {
    blockOn: GateLevel;
    ignorePaths: string[];
    languages: string[];
  },
  rl?: readline.Interface,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<{
  blockOn: GateLevel;
  ignorePaths: string[];
  languages: string[];
}> {
  const readlineInterface =
    rl ||
    readline.createInterface({
      input,
      output,
    });
  const shouldClose = !rl;

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => readlineInterface.question(q, resolve));

  try {
    output.write("\n🛡️  SecureFlow Repository Configuration Setup:\n");

    // 1. Minimum blocking severity
    const sevAnswer = await ask(
      `1. Minimum blocking severity (CRITICAL, HIGH, MEDIUM, LOW) [default: ${defaults.blockOn}]: `,
    );
    let blockOn = defaults.blockOn;
    const sevTrim = sevAnswer.trim().toUpperCase();
    if (["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"].includes(sevTrim)) {
      blockOn = sevTrim as GateLevel;
    }

    // 2. Paths to ignore
    const defaultIgnoreStr = defaults.ignorePaths.join(", ");
    const ignoreAnswer = await ask(
      `2. Paths to ignore (comma-separated globs) [default: ${defaultIgnoreStr}]: `,
    );
    let ignorePaths = defaults.ignorePaths;
    if (ignoreAnswer.trim()) {
      ignorePaths = ignoreAnswer
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    }

    // 3. Languages in the repository
    const defaultLangStr = defaults.languages.join(", ");
    const langAnswer = await ask(
      `3. Languages in the repository (e.g. typescript, python, terraform) [default: ${defaultLangStr}]: `,
    );
    let languages = defaults.languages;
    if (langAnswer.trim()) {
      languages = langAnswer
        .split(",")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    }

    return { blockOn, ignorePaths, languages };
  } finally {
    if (shouldClose) readlineInterface.close();
  }
}

/**
 * Initializes `.secureflow.json` and `.secureflowignore` in the target directory.
 * Safely guards against overwriting existing files without confirmation or --force.
 */
export async function initConfigFiles(options: InitConfigOptions = {}): Promise<InitConfigResult> {
  const targetDir = options.targetDir || process.cwd();
  const jsonPath = path.join(targetDir, ".secureflow.json");
  const ignorePath = path.join(targetDir, ".secureflowignore");
  const messages: string[] = [];

  const detectedLangs = detectRepoLanguages(targetDir);
  const defaultIgnorePaths = [
    "node_modules/**",
    "dist/**",
    "build/**",
    ".git/**",
    "coverage/**",
  ];

  let blockOn: GateLevel = options.blockOn ?? "HIGH";
  let ignorePaths: string[] = options.ignorePaths ?? defaultIgnorePaths;
  let languages: string[] = options.languages ?? detectedLangs;

  const isInteractive =
    options.interactive ??
    ((options.stdin as any)?.isTTY ?? (process.stdin.isTTY && !process.env.CI));

  if (isInteractive && !options.blockOn && !options.ignorePaths && !options.languages) {
    const answers = await promptConfigQuestions(
      { blockOn, ignorePaths, languages },
      options.rl,
      options.stdin,
      options.stdout,
    );
    blockOn = answers.blockOn;
    ignorePaths = answers.ignorePaths;
    languages = answers.languages;
  }

  let jsonCreated = false;
  let jsonSkipped = false;
  let ignoreCreated = false;
  let ignoreSkipped = false;

  // Handle .secureflow.json
  if (fs.existsSync(jsonPath)) {
    let shouldOverwrite = Boolean(options.force);
    if (!shouldOverwrite && isInteractive) {
      shouldOverwrite = await promptOverwrite(
        ".secureflow.json",
        options.rl,
        options.stdin,
        options.stdout,
      );
    }

    if (shouldOverwrite) {
      const content = generateSecureFlowJson({ blockOn, languages });
      fs.writeFileSync(jsonPath, content, "utf-8");
      jsonCreated = true;
      messages.push(`Overwrote existing ${path.basename(jsonPath)}`);
    } else {
      jsonSkipped = true;
      messages.push(`Skipped existing ${path.basename(jsonPath)} (not overwritten)`);
    }
  } else {
    const content = generateSecureFlowJson({ blockOn, languages });
    fs.writeFileSync(jsonPath, content, "utf-8");
    jsonCreated = true;
    messages.push(`Created ${path.basename(jsonPath)}`);
  }

  // Handle .secureflowignore
  if (fs.existsSync(ignorePath)) {
    let shouldOverwrite = Boolean(options.force);
    if (!shouldOverwrite && isInteractive) {
      shouldOverwrite = await promptOverwrite(
        ".secureflowignore",
        options.rl,
        options.stdin,
        options.stdout,
      );
    }

    if (shouldOverwrite) {
      const content = generateSecureFlowIgnore({ ignorePaths });
      fs.writeFileSync(ignorePath, content, "utf-8");
      ignoreCreated = true;
      messages.push(`Overwrote existing ${path.basename(ignorePath)}`);
    } else {
      ignoreSkipped = true;
      messages.push(`Skipped existing ${path.basename(ignorePath)} (not overwritten)`);
    }
  } else {
    const content = generateSecureFlowIgnore({ ignorePaths });
    fs.writeFileSync(ignorePath, content, "utf-8");
    ignoreCreated = true;
    messages.push(`Created ${path.basename(ignorePath)}`);
  }

  return {
    jsonCreated,
    ignoreCreated,
    jsonSkipped,
    ignoreSkipped,
    jsonPath,
    ignorePath,
    messages,
  };
}

/**
 * Validates configuration files (.secureflow.json and .secureflowignore) against schemas.
 */
export function validateConfigFiles(options: ValidateConfigOptions = {}): ConfigValidationReport {
  const targetDir = options.targetDir || process.cwd();
  const allErrors: ValidationError[] = [];
  const files: Record<string, FileValidationResult> = {};

  if (options.filePath) {
    const fullPath = path.isAbsolute(options.filePath)
      ? options.filePath
      : path.join(targetDir, options.filePath);
    const basename = path.basename(fullPath);

    if (!fs.existsSync(fullPath)) {
      const err: ValidationError = {
        file: basename,
        line: 1,
        message: `Configuration file '${options.filePath}' not found`,
        code: "FILE_NOT_FOUND",
      };
      allErrors.push(err);
      files[basename] = { file: basename, exists: false, valid: false, errors: [err] };
      return { valid: false, files, allErrors };
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    let fileErrors: ValidationError[] = [];

    if (basename.endsWith(".json")) {
      fileErrors = validateSecureFlowJson(content, basename);
    } else {
      fileErrors = validateSecureFlowIgnore(content, basename);
    }

    allErrors.push(...fileErrors);
    files[basename] = {
      file: basename,
      exists: true,
      valid: fileErrors.length === 0,
      errors: fileErrors,
    };

    return { valid: allErrors.length === 0, files, allErrors };
  }

  // Validate standard config files in target directory
  const jsonPath = path.join(targetDir, ".secureflow.json");
  const ignorePath = path.join(targetDir, ".secureflowignore");

  let jsonFound = false;
  let ignoreFound = false;

  if (fs.existsSync(jsonPath)) {
    jsonFound = true;
    const content = fs.readFileSync(jsonPath, "utf-8");
    const jsonErrors = validateSecureFlowJson(content, ".secureflow.json");
    allErrors.push(...jsonErrors);
    files[".secureflow.json"] = {
      file: ".secureflow.json",
      exists: true,
      valid: jsonErrors.length === 0,
      errors: jsonErrors,
    };
  }

  if (fs.existsSync(ignorePath)) {
    ignoreFound = true;
    const content = fs.readFileSync(ignorePath, "utf-8");
    const ignoreErrors = validateSecureFlowIgnore(content, ".secureflowignore");
    allErrors.push(...ignoreErrors);
    files[".secureflowignore"] = {
      file: ".secureflowignore",
      exists: true,
      valid: ignoreErrors.length === 0,
      errors: ignoreErrors,
    };
  }

  if (!jsonFound && !ignoreFound) {
    allErrors.push({
      file: ".secureflow.json / .secureflowignore",
      line: 1,
      message: "No SecureFlow configuration files (.secureflow.json or .secureflowignore) found",
      code: "FILE_NOT_FOUND",
    });
  }

  return {
    valid: allErrors.length === 0,
    files,
    allErrors,
  };
}
