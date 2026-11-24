import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Dev Container & Codespaces configuration (#1985)", () => {
  const rootDir = process.cwd();
  const devcontainerDir = path.join(rootDir, ".devcontainer");
  const devcontainerJsonPath = path.join(devcontainerDir, "devcontainer.json");
  const dockerComposePath = path.join(devcontainerDir, "docker-compose.yml");
  const postCreateScriptPath = path.join(devcontainerDir, "post-create.sh");
  const contributingPath = path.join(rootDir, "CONTRIBUTING.md");
  const nvmrcPath = path.join(rootDir, ".nvmrc");

  it("provides a valid .devcontainer/devcontainer.json configuration", () => {
    expect(fs.existsSync(devcontainerJsonPath)).toBe(true);
    const content = fs.readFileSync(devcontainerJsonPath, "utf8");
    const config = JSON.parse(content);

    expect(config.name).toBeDefined();
    expect(config.dockerComposeFile).toBe("docker-compose.yml");
    expect(config.service).toBe("app");
    expect(config.workspaceFolder).toBe("/workspaces/SecureFlow");
    expect(config.remoteUser).toBe("node");
  });

  it("preconfigures and recommends required VS Code extensions", () => {
    const config = JSON.parse(fs.readFileSync(devcontainerJsonPath, "utf8"));
    const extensions: string[] = config.customizations?.vscode?.extensions || [];

    expect(extensions).toContain("dbaeumer.vscode-eslint");
    expect(extensions).toContain("esbenp.prettier-vscode");
    expect(extensions).toContain("Prisma.prisma");
    expect(extensions).toContain("ms-playwright.playwright");
  });

  it("forwards required application, database, and cache ports", () => {
    const config = JSON.parse(fs.readFileSync(devcontainerJsonPath, "utf8"));
    const forwardPorts: number[] = config.forwardPorts || [];

    expect(forwardPorts).toContain(9002); // Next.js dashboard
    expect(forwardPorts).toContain(5432); // PostgreSQL
    expect(forwardPorts).toContain(6379); // Redis

    expect(config.portsAttributes).toHaveProperty("9002");
    expect(config.portsAttributes).toHaveProperty("5432");
    expect(config.portsAttributes).toHaveProperty("6379");
  });

  it("configures postCreateCommand to run setup steps", () => {
    const config = JSON.parse(fs.readFileSync(devcontainerJsonPath, "utf8"));
    expect(config.postCreateCommand).toBeDefined();
    expect(config.postCreateCommand).toContain("post-create.sh");
  });

  it("provides .devcontainer/docker-compose.yml with app, db, and redis services matching stack versions", () => {
    expect(fs.existsSync(dockerComposePath)).toBe(true);
    const composeContent = fs.readFileSync(dockerComposePath, "utf8");

    // Services exist
    expect(composeContent).toContain("app:");
    expect(composeContent).toContain("db:");
    expect(composeContent).toContain("redis:");

    // App uses Node 22 matching .nvmrc
    const nvmVersion = fs.existsSync(nvmrcPath) ? fs.readFileSync(nvmrcPath, "utf8").trim() : "22";
    expect(composeContent).toContain(`22`);

    // PostgreSQL and Redis versions
    expect(composeContent).toContain("postgres:16-alpine");
    expect(composeContent).toContain("redis:7-alpine");

    // App depends on healthy db and redis
    expect(composeContent).toContain("service_healthy");
  });

  it("implements post-create.sh with npm ci, safe local .env defaults, and migrations", () => {
    expect(fs.existsSync(postCreateScriptPath)).toBe(true);
    const script = fs.readFileSync(postCreateScriptPath, "utf8");

    expect(script).toContain("npm ci");
    expect(script).toContain(".env.example");
    expect(script).toContain("prisma");
    expect(script).toContain("migrate");
  });

  it("does not include real secrets or tokens in any devcontainer file", () => {
    const filesToCheck = [devcontainerJsonPath, dockerComposePath, postCreateScriptPath];
    const suspiciousPatterns = [
      /ghp_[a-zA-Z0-9]{36}/,
      /github_pat_[a-zA-Z0-9_]{50,}/,
      /gsk_[a-zA-Z0-9]{40,}/,
      /eyJ[a-zA-Z0-9_-]{30,}\.eyJ[a-zA-Z0-9_-]{30,}/,
      /AKIA[0-9A-Z]{16}/,
    ];

    for (const filePath of filesToCheck) {
      const content = fs.readFileSync(filePath, "utf8");
      for (const pattern of suspiciousPatterns) {
        expect(pattern.test(content)).toBe(false);
      }
    }
  });

  it("documents Dev Containers and Codespaces in CONTRIBUTING.md with badge", () => {
    expect(fs.existsSync(contributingPath)).toBe(true);
    const contributingContent = fs.readFileSync(contributingPath, "utf8");

    expect(contributingContent).toContain("https://github.com/codespaces/badge.svg");
    expect(contributingContent).toContain("Dev Container");
    expect(contributingContent).toContain("Codespaces");
    expect(contributingContent).toContain("postCreateCommand");
  });
});
