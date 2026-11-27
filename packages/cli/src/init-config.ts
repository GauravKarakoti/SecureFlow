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
} from "./contracts/index.js";

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
  }> = [];

  if (langs.includes("terraform")) {
    policyScopes.push({
      paths: ["terraform/**", "*.tf"],
      enable: ["Infrastructure Security", "Hardcoded Secrets"],
    });
  }

  if (langs.includes("typescript") || langs.includes("javascript") || langs.includes("frontend")) {
    policyScopes.push({
      paths: ["src/**", "components/**"],
      enable: ["Cross-Site Scripting (XSS)", "Content Security Policy", "No Hardcoded Secrets"],
    });
  }

  if (langs.includes("python")) {
    policyScopes.push({
      paths: ["**/*.py"],
      enable: ["Injection Prevention", "No Hardcoded Secrets"],
    });
  }

  // Common testing scope
  policyScopes.push({
    paths: ["tests/**", "**/*.test.*", "**/*.spec.*", "fixtures/**"],
    disable: ["No Hardcoded Secrets"],
  });

  const formattedScopes = policyScopes
    .map((scope) => {
      const lines = ["    {"];
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
    `{`,
    `  "$schema": "https://secure-flow-six.vercel.app/schema.json",`,
    `  "gate": {`,
    `    "blockOn": "${blockOn}",`,
    `    "reviewOn": "MEDIUM",`,
    `    "paths": [`,
    `      { "glob": "infra/**", "blockOn": "HIGH" },`,
    `      { "glob": "tests/**", "blockOn": "NONE", "reviewOn": "NONE" }`,
    `    ]`,
    `  },`,
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
 * Safely writes a configuration file, avoiding TOCTOU race conditions by attempting
 * atomic exclusive creation first when not overwriting, and checking for interactive confirmation.
 */
async function writeConfigFile(
  filePath: string,
  content: string,
  options: {
    force?: boolean | undefined;
    isInteractive: boolean;
    rl?: readline.Interface | undefined;
    stdin?: NodeJS.ReadableStream | undefined;
    stdout?: NodeJS.WritableStream | undefined;
  },
): Promise<{ created: boolean; skipped: boolean; message: string }> {
  const filename = path.basename(filePath);

  if (options.force) {
    const existed = fs.existsSync(filePath);
    fs.writeFileSync(filePath, content, { encoding: "utf-8", flag: "w" });
    return {
      created: true,
      skipped: false,
      message: existed ? `Overwrote existing ${filename}` : `Created ${filename}`,
    };
  }

  // Attempt atomic exclusive creation first to avoid file-system race condition (TOCTOU)
  try {
    fs.writeFileSync(filePath, content, { encoding: "utf-8", flag: "wx" });
    return {
      created: true,
      skipped: false,
      message: `Created ${filename}`,
    };
  } catch (err: any) {
    if (err?.code !== "EEXIST") {
      throw err;
    }
  }

  // File exists; prompt if in interactive mode
  let shouldOverwrite = false;
  if (options.isInteractive) {
    shouldOverwrite = await promptOverwrite(filename, options.rl, options.stdin, options.stdout);
  }

  if (shouldOverwrite) {
    fs.writeFileSync(filePath, content, { encoding: "utf-8", flag: "w" });
    return {
      created: true,
      skipped: false,
      message: `Overwrote existing ${filename}`,
    };
  }

  return {
    created: false,
    skipped: true,
    message: `Skipped existing ${filename} (not overwritten)`,
  };
}

export async function initConfigFiles(options: InitConfigOptions = {}): Promise<InitConfigResult> {
  const targetDir = options.targetDir || process.cwd();
  const jsonPath = path.join(targetDir, ".secureflow.json");
  const ignorePath = path.join(targetDir, ".secureflowignore");
  const messages: string[] = [];

  const detectedLanguages = detectRepoLanguages(targetDir);
  const defaultIgnorePaths = ["node_modules/**", "dist/**", "build/**", ".git/**", "coverage/**"];

  let blockOn: GateLevel = options.blockOn || "HIGH";
  let ignorePaths: string[] = options.ignorePaths || defaultIgnorePaths;
  let languages: string[] = options.languages || detectedLanguages;

  const isInteractive =
    options.interactive ??
    (options.stdin as any)?.isTTY ??
    (process.stdin.isTTY && !process.env.CI);

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

  const jsonContent = generateSecureFlowJson({ blockOn, languages });
  const jsonRes = await writeConfigFile(jsonPath, jsonContent, {
    force: options.force,
    isInteractive,
    rl: options.rl,
    stdin: options.stdin,
    stdout: options.stdout,
  });
  messages.push(jsonRes.message);

  const ignoreContent = generateSecureFlowIgnore({ ignorePaths });
  const ignoreRes = await writeConfigFile(ignorePath, ignoreContent, {
    force: options.force,
    isInteractive,
    rl: options.rl,
    stdin: options.stdin,
    stdout: options.stdout,
  });
  messages.push(ignoreRes.message);

  return {
    jsonCreated: jsonRes.created,
    ignoreCreated: ignoreRes.created,
    jsonSkipped: jsonRes.skipped,
    ignoreSkipped: ignoreRes.skipped,
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

    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch (err: any) {
      if (err?.code === "ENOENT" || !fs.existsSync(fullPath)) {
        const fileErr: ValidationError = {
          file: basename,
          line: 1,
          message: `Configuration file '${options.filePath}' not found`,
          code: "FILE_NOT_FOUND",
        };
        allErrors.push(fileErr);
        files[basename] = { file: basename, exists: false, valid: false, errors: [fileErr] };
        return { valid: false, files, allErrors };
      }
      throw err;
    }

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

  try {
    const content = fs.readFileSync(jsonPath, "utf-8");
    jsonFound = true;
    const jsonErrors = validateSecureFlowJson(content, ".secureflow.json");
    allErrors.push(...jsonErrors);
    files[".secureflow.json"] = {
      file: ".secureflow.json",
      exists: true,
      valid: jsonErrors.length === 0,
      errors: jsonErrors,
    };
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }

  try {
    const content = fs.readFileSync(ignorePath, "utf-8");
    ignoreFound = true;
    const ignoreErrors = validateSecureFlowIgnore(content, ".secureflowignore");
    allErrors.push(...ignoreErrors);
    files[".secureflowignore"] = {
      file: ".secureflowignore",
      exists: true,
      valid: ignoreErrors.length === 0,
      errors: ignoreErrors,
    };
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
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
