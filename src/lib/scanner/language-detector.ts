/**
 * Language and Framework Detection for Code Changes
 *
 * Deterministically maps changed files to their language / file type using:
 * - Well-known filenames (Dockerfile, Makefile, package.json, etc.)
 * - File path patterns (*.tf, .github/workflows/*.yml, etc.)
 * - Standard file extensions (.ts, .py, .go, .rs, etc.)
 * - Shebang lines for extensionless scripts or files
 *
 * Also detects frameworks cheaply from imports/content or manifest files.
 * Unknown files safely return { language: "unknown" } without errors.
 */

export interface DetectedLanguageContext {
  language: string;
  framework?: string;
}

const WELL_KNOWN_EXACT_NAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  jenkinsfile: "groovy",
  gemfile: "ruby",
  rakefile: "ruby",
  vagrantfile: "ruby",
  procfile: "procfile",
  "package.json": "json",
  "package-lock.json": "json",
  "tsconfig.json": "json",
  "jsconfig.json": "json",
  "composer.json": "json",
  "composer.lock": "json",
  "cargo.toml": "toml",
  "cargo.lock": "toml",
  "pyproject.toml": "toml",
  "requirements.txt": "python",
  pipfile: "python",
  "go.mod": "go",
  "go.sum": "go",
  "pom.xml": "xml",
  "build.gradle": "groovy",
  "build.gradle.kts": "kotlin",
  podfile: "ruby",
  ".gitignore": "ignore",
  ".npmignore": "ignore",
  ".dockerignore": "ignore",
  ".secureflowignore": "ignore",
};

const EXTENSION_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  pyw: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  h: "cpp",
  swift: "swift",
  scala: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sol: "solidity",
  circom: "circom",
  leo: "leo",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  lua: "lua",
  r: "r",
  dart: "dart",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "hcl",
  env: "dotenv",
};

/**
 * Extracts a shebang interpreter from the content or patch.
 */
function extractShebangLanguage(contentOrPatch: string): string | undefined {
  if (!contentOrPatch) return undefined;

  // Search first 500 characters or lines for shebang (including diff '+' prefix)
  const shebangMatch = contentOrPatch.match(/(?:^|\n)\+?#!\s*(?:[^\n\r]+?\/)?([a-zA-Z0-9._-]+)(?:\s+([^\n\r]+))?(?:\r?\n|$)/);
  if (!shebangMatch) return undefined;

  let binary = shebangMatch[1]?.toLowerCase() || "";
  const args = shebangMatch[2]?.toLowerCase() || "";

  if (binary === "env" && args) {
    const firstArg = args.trim().split(/\s+/)[0];
    if (firstArg) binary = firstArg;
  }

  if (binary.startsWith("python")) return "python";
  if (binary === "node" || binary === "nodejs") return "javascript";
  if (binary === "bash" || binary === "sh" || binary === "zsh" || binary === "ksh") return "shell";
  if (binary === "ruby") return "ruby";
  if (binary === "perl") return "perl";
  if (binary === "php") return "php";

  return undefined;
}

/**
 * Cheap framework detection by inspecting content/patch imports, annotations, or manifests.
 */
function detectFramework(language: string, filename: string, contentOrPatch: string): string | undefined {
  if (!contentOrPatch) return undefined;

  const lowerContent = contentOrPatch.toLowerCase();
  const lowerFilename = filename.toLowerCase();

  // JSON package manifest check
  if (lowerFilename.endsWith("package.json")) {
    if (lowerContent.includes('"@nestjs/core"') || lowerContent.includes('"@nestjs/common"')) return "nestjs";
    if (lowerContent.includes('"next"')) return "next.js";
    if (lowerContent.includes('"express"')) return "express";
    if (lowerContent.includes('"react"')) return "react";
    if (lowerContent.includes('"fastify"')) return "fastify";
    if (lowerContent.includes('"vue"')) return "vue";
    return undefined;
  }

  // JS / TS frameworks
  if (language === "javascript" || language === "typescript") {
    if (
      lowerContent.includes("@nestjs/") ||
      lowerContent.includes("from '@nestjs/") ||
      lowerContent.includes('from "@nestjs/')
    ) {
      return "nestjs";
    }
    if (
      lowerContent.includes('from "next') ||
      lowerContent.includes("from 'next") ||
      lowerContent.includes('require("next') ||
      lowerContent.includes("require('next") ||
      lowerFilename.includes("next.config.")
    ) {
      return "next.js";
    }
    if (
      lowerContent.includes('from "express"') ||
      lowerContent.includes("from 'express'") ||
      lowerContent.includes('require("express")') ||
      lowerContent.includes("require('express')") ||
      lowerContent.includes("express()")
    ) {
      return "express";
    }
    if (
      lowerContent.includes('from "react"') ||
      lowerContent.includes("from 'react'") ||
      lowerContent.includes('require("react")') ||
      lowerContent.includes("require('react')")
    ) {
      return "react";
    }
    if (
      lowerContent.includes('from "fastify"') ||
      lowerContent.includes("from 'fastify'") ||
      lowerContent.includes("fastify()")
    ) {
      return "fastify";
    }
    if (
      lowerContent.includes('from "vue"') ||
      lowerContent.includes("from 'vue'")
    ) {
      return "vue";
    }
  }

  // Python frameworks
  if (language === "python") {
    if (
      lowerContent.includes("from fastapi") ||
      lowerContent.includes("import fastapi")
    ) {
      return "fastapi";
    }
    if (
      lowerContent.includes("from django") ||
      lowerContent.includes("import django")
    ) {
      return "django";
    }
    if (
      lowerContent.includes("from flask") ||
      lowerContent.includes("import flask")
    ) {
      return "flask";
    }
  }

  // Java frameworks
  if (language === "java" || language === "kotlin") {
    if (
      lowerContent.includes("org.springframework") ||
      lowerContent.includes("@springbootapplication") ||
      lowerContent.includes("@restcontroller") ||
      lowerContent.includes("@autowired")
    ) {
      return "spring";
    }
  }

  // Go frameworks
  if (language === "go") {
    if (lowerContent.includes("github.com/gin-gonic/gin")) return "gin";
    if (lowerContent.includes("github.com/labstack/echo")) return "echo";
    if (lowerContent.includes("github.com/gofiber/fiber")) return "fiber";
  }

  // Rust frameworks
  if (language === "rust") {
    if (lowerContent.includes("actix_web") || lowerContent.includes("actix-web")) return "actix";
    if (lowerContent.includes("axum::") || lowerContent.includes("axum")) return "axum";
    if (lowerContent.includes("rocket::") || lowerContent.includes("rocket")) return "rocket";
  }

  // Ruby frameworks
  if (language === "ruby") {
    if (
      lowerContent.includes("rails") ||
      lowerContent.includes("activerecord") ||
      lowerContent.includes("actioncontroller")
    ) {
      return "rails";
    }
  }

  // PHP frameworks
  if (language === "php") {
    if (lowerContent.includes("illuminate\\") || lowerContent.includes("laravel")) return "laravel";
    if (lowerContent.includes("symfony\\")) return "symfony";
  }

  // C# frameworks
  if (language === "csharp") {
    if (lowerContent.includes("microsoft.aspnetcore")) return "aspnet";
  }

  return undefined;
}

/**
 * Deterministically maps each changed file to a language or file type and detects framework.
 *
 * @param filename - File path or filename (e.g. "src/index.ts", "Dockerfile", "scripts/deploy")
 * @param contentOrPatch - Optional file content or diff patch for shebang / framework inspection
 * @returns DetectedLanguageContext containing language (or "unknown") and optional framework.
 */
export function detectFileLanguage(
  filename?: string | null,
  contentOrPatch?: string | null,
): DetectedLanguageContext {
  if (!filename || typeof filename !== "string" || !filename.trim()) {
    return { language: "unknown" };
  }

  const normalizedPath = filename.trim().replace(/\\/g, "/");
  const basename = normalizedPath.split("/").pop() || "";
  const lowerBasename = basename.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();

  // 1. Check GitHub Actions workflow files (.github/workflows/*.yml or *.yaml)
  if (
    lowerPath.includes(".github/workflows/") &&
    (lowerBasename.endsWith(".yml") || lowerBasename.endsWith(".yaml"))
  ) {
    const framework = contentOrPatch
      ? detectFramework("github-actions", basename, contentOrPatch)
      : undefined;
    return {
      language: "github-actions",
      ...(framework ? { framework } : {}),
    };
  }

  // 2. Check exact well-known filenames
  if (WELL_KNOWN_EXACT_NAMES[lowerBasename]) {
    const lang = WELL_KNOWN_EXACT_NAMES[lowerBasename];
    const framework = contentOrPatch ? detectFramework(lang, basename, contentOrPatch) : undefined;
    return {
      language: lang,
      ...(framework ? { framework } : {}),
    };
  }

  // 3. Check well-known patterns (Dockerfile.*, *.dockerfile, .env.*)
  if (
    lowerBasename.startsWith("dockerfile.") ||
    lowerBasename.endsWith(".dockerfile") ||
    lowerBasename === "containerfile" ||
    lowerBasename.startsWith("containerfile.")
  ) {
    return { language: "dockerfile" };
  }

  if (lowerBasename.startsWith(".env")) {
    return { language: "dotenv" };
  }

  // 4. Check file extension
  const dotIndex = basename.lastIndexOf(".");
  let detectedLang: string | undefined;

  if (dotIndex > 0 && dotIndex < basename.length - 1) {
    const ext = basename.slice(dotIndex + 1).toLowerCase();
    detectedLang = EXTENSION_MAP[ext];
  }

  // 5. If extension not found or file has no extension, check shebang from content
  if (!detectedLang && contentOrPatch) {
    detectedLang = extractShebangLanguage(contentOrPatch);
  }

  if (!detectedLang) {
    return { language: "unknown" };
  }

  const framework = contentOrPatch
    ? detectFramework(detectedLang, basename, contentOrPatch)
    : undefined;

  return {
    language: detectedLang,
    ...(framework ? { framework } : {}),
  };
}
