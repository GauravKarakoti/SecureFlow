import { describe, it, expect } from "vitest";
import { detectFileLanguage } from "./language-detector";

describe("detectFileLanguage", () => {
  describe("Extension mapping", () => {
    it("detects TypeScript and JavaScript variants", () => {
      expect(detectFileLanguage("src/index.ts")).toEqual({ language: "typescript" });
      expect(detectFileLanguage("components/Button.tsx")).toEqual({ language: "typescript" });
      expect(detectFileLanguage("utils/helper.js")).toEqual({ language: "javascript" });
      expect(detectFileLanguage("utils/helper.mjs")).toEqual({ language: "javascript" });
      expect(detectFileLanguage("utils/helper.cjs")).toEqual({ language: "javascript" });
      expect(detectFileLanguage("components/App.jsx")).toEqual({ language: "javascript" });
    });

    it("detects backend languages", () => {
      expect(detectFileLanguage("server.py")).toEqual({ language: "python" });
      expect(detectFileLanguage("main.go")).toEqual({ language: "go" });
      expect(detectFileLanguage("lib.rs")).toEqual({ language: "rust" });
      expect(detectFileLanguage("Application.java")).toEqual({ language: "java" });
      expect(detectFileLanguage("app.rb")).toEqual({ language: "ruby" });
      expect(detectFileLanguage("index.php")).toEqual({ language: "php" });
      expect(detectFileLanguage("Program.cs")).toEqual({ language: "csharp" });
      expect(detectFileLanguage("main.c")).toEqual({ language: "c" });
      expect(detectFileLanguage("core.cpp")).toEqual({ language: "cpp" });
    });

    it("detects smart contract & zero-knowledge formats", () => {
      expect(detectFileLanguage("contracts/Vault.sol")).toEqual({ language: "solidity" });
      expect(detectFileLanguage("circuits/multiplier.circom")).toEqual({ language: "circom" });
      expect(detectFileLanguage("programs/token.leo")).toEqual({ language: "leo" });
    });

    it("detects configuration, data and infra formats", () => {
      expect(detectFileLanguage("infra/main.tf")).toEqual({ language: "terraform" });
      expect(detectFileLanguage("infra/variables.tfvars")).toEqual({ language: "terraform" });
      expect(detectFileLanguage("config.hcl")).toEqual({ language: "hcl" });
      expect(detectFileLanguage("schema.sql")).toEqual({ language: "sql" });
      expect(detectFileLanguage("config.json")).toEqual({ language: "json" });
      expect(detectFileLanguage("deploy.yaml")).toEqual({ language: "yaml" });
      expect(detectFileLanguage("deploy.yml")).toEqual({ language: "yaml" });
      expect(detectFileLanguage("styles.css")).toEqual({ language: "css" });
      expect(detectFileLanguage("index.html")).toEqual({ language: "html" });
    });
  });

  describe("Well-known files & path patterns", () => {
    it("detects Dockerfiles", () => {
      expect(detectFileLanguage("Dockerfile")).toEqual({ language: "dockerfile" });
      expect(detectFileLanguage("docker/Dockerfile.prod")).toEqual({ language: "dockerfile" });
      expect(detectFileLanguage("deploy.dockerfile")).toEqual({ language: "dockerfile" });
      expect(detectFileLanguage("Containerfile")).toEqual({ language: "dockerfile" });
    });

    it("detects Makefiles and scripts", () => {
      expect(detectFileLanguage("Makefile")).toEqual({ language: "makefile" });
      expect(detectFileLanguage("GNUMakefile")).toEqual({ language: "makefile" });
    });

    it("detects package manifests and lockfiles", () => {
      expect(detectFileLanguage("package.json")).toEqual({ language: "json" });
      expect(detectFileLanguage("package-lock.json")).toEqual({ language: "json" });
      expect(detectFileLanguage("Cargo.toml")).toEqual({ language: "toml" });
      expect(detectFileLanguage("requirements.txt")).toEqual({ language: "python" });
      expect(detectFileLanguage("go.mod")).toEqual({ language: "go" });
      expect(detectFileLanguage("pom.xml")).toEqual({ language: "xml" });
      expect(detectFileLanguage("Gemfile")).toEqual({ language: "ruby" });
    });

    it("detects GitHub Actions workflow files", () => {
      expect(detectFileLanguage(".github/workflows/ci.yml")).toEqual({ language: "github-actions" });
      expect(detectFileLanguage(".github/workflows/deploy.yaml")).toEqual({ language: "github-actions" });
    });

    it("detects environment files", () => {
      expect(detectFileLanguage(".env")).toEqual({ language: "dotenv" });
      expect(detectFileLanguage(".env.example")).toEqual({ language: "dotenv" });
      expect(detectFileLanguage(".env.production")).toEqual({ language: "dotenv" });
    });
  });

  describe("Extensionless files with shebangs", () => {
    it("detects bash/sh scripts without extension", () => {
      const patch = "@@ -0,0 +1,2 @@\n+#!/bin/bash\necho 'hello'";
      expect(detectFileLanguage("scripts/deploy", patch)).toEqual({ language: "shell" });

      const envSh = "#!/usr/bin/env sh\necho 'hi'";
      expect(detectFileLanguage("bin/run", envSh)).toEqual({ language: "shell" });
    });

    it("detects python scripts without extension", () => {
      const patch = "+#!/usr/bin/env python3\nimport sys\nprint('running')";
      expect(detectFileLanguage("bin/generate-report", patch)).toEqual({ language: "python" });
    });

    it("detects node scripts without extension", () => {
      const patch = "#!/usr/bin/env node\nconsole.log('hi')";
      expect(detectFileLanguage("cli/run", patch)).toEqual({ language: "javascript" });
    });

    it("detects ruby and perl scripts without extension", () => {
      expect(detectFileLanguage("bin/worker", "#!/usr/bin/env ruby\nputs 1")).toEqual({ language: "ruby" });
      expect(detectFileLanguage("bin/audit", "#!/usr/bin/perl\nprint 1;")).toEqual({ language: "perl" });
    });
  });

  describe("Framework detection", () => {
    it("detects Express in JS/TS", () => {
      const content = `import express from "express";\nconst app = express();`;
      expect(detectFileLanguage("src/server.ts", content)).toEqual({
        language: "typescript",
        framework: "express",
      });
    });

    it("detects Next.js in JS/TS", () => {
      const content = `import { NextResponse } from "next/server";\nexport async function GET() {}`;
      expect(detectFileLanguage("src/app/api/route.ts", content)).toEqual({
        language: "typescript",
        framework: "next.js",
      });
    });

    it("detects React in JS/TS", () => {
      const content = `import React, { useState } from "react";`;
      expect(detectFileLanguage("src/Button.tsx", content)).toEqual({
        language: "typescript",
        framework: "react",
      });
    });

    it("detects NestJS in JS/TS", () => {
      const content = `import { Controller, Get } from "@nestjs/common";`;
      expect(detectFileLanguage("src/app.controller.ts", content)).toEqual({
        language: "typescript",
        framework: "nestjs",
      });
    });

    it("detects Python frameworks: FastAPI, Flask, Django", () => {
      expect(
        detectFileLanguage("main.py", "from fastapi import FastAPI\napp = FastAPI()"),
      ).toEqual({
        language: "python",
        framework: "fastapi",
      });

      expect(
        detectFileLanguage("app.py", "from flask import Flask\napp = Flask(__name__)"),
      ).toEqual({
        language: "python",
        framework: "flask",
      });

      expect(
        detectFileLanguage("views.py", "from django.http import HttpResponse"),
      ).toEqual({
        language: "python",
        framework: "django",
      });
    });

    it("detects Spring in Java", () => {
      const content = `import org.springframework.web.bind.annotation.RestController;\n@RestController\npublic class App {}`;
      expect(detectFileLanguage("App.java", content)).toEqual({
        language: "java",
        framework: "spring",
      });
    });

    it("detects Gin and Echo in Go", () => {
      expect(
        detectFileLanguage("main.go", 'import "github.com/gin-gonic/gin"'),
      ).toEqual({
        language: "go",
        framework: "gin",
      });
    });

    it("detects Actix in Rust", () => {
      expect(
        detectFileLanguage("main.rs", "use actix_web::{get, App, HttpServer};"),
      ).toEqual({
        language: "rust",
        framework: "actix",
      });
    });

    it("detects frameworks in package.json manifest", () => {
      const manifest = JSON.stringify({
        dependencies: {
          express: "^4.18.2",
        },
      });
      expect(detectFileLanguage("package.json", manifest)).toEqual({
        language: "json",
        framework: "express",
      });
    });
  });

  describe("Unknown files & edge cases", () => {
    it("returns unknown for unrecognized extensions without shebang", () => {
      expect(detectFileLanguage("data.xyz999")).toEqual({ language: "unknown" });
      expect(detectFileLanguage("some_file_without_ext")).toEqual({ language: "unknown" });
    });

    it("safely handles null, undefined, empty strings", () => {
      expect(detectFileLanguage("")).toEqual({ language: "unknown" });
      expect(detectFileLanguage("   ")).toEqual({ language: "unknown" });
      expect(detectFileLanguage(null)).toEqual({ language: "unknown" });
      expect(detectFileLanguage(undefined)).toEqual({ language: "unknown" });
    });

    it("handles files with multiple dots", () => {
      expect(detectFileLanguage("src/components/button.test.tsx")).toEqual({
        language: "typescript",
      });
      expect(detectFileLanguage("archive.tar.gz")).toEqual({
        language: "unknown",
      });
    });
  });
});
