import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import config from "../docs/.vitepress/config";

describe("Documentation Site & Netlify Deployment (#2107)", () => {
  const rootDir = path.resolve(__dirname, "..");
  const docsDir = path.resolve(rootDir, "docs");

  it("configures VitePress with title, local full-text search, and GitHub edit links", () => {
    expect(config.title).toBe("SecureFlow Docs");
    expect(config.themeConfig?.search?.provider).toBe("local");
    expect(config.themeConfig?.editLink?.pattern).toContain(
      "https://github.com/GauravKarakoti/SecureFlow/edit/main/docs/:path",
    );
  });

  it("lists the npm API client and the Marketplace GitHub Action in the version dropdown (#2170)", () => {
    const nav = (config.themeConfig?.nav ?? []) as { text: string; items?: { link: string }[] }[];
    const links = nav.find((item) => item.text === "v0.1.0")?.items?.map((item) => item.link);

    expect(links).toContain("https://www.npmjs.com/package/@secureflow/api-client");
    expect(links).toContain("https://github.com/marketplace/actions/secureflow-security-scan");
  });

  it("mirrors folder structure and ensures every sidebar link exists on disk", () => {
    const sidebar = config.themeConfig?.sidebar;
    expect(Array.isArray(sidebar)).toBe(true);

    const sections = (sidebar as any[]) || [];
    expect(sections.length).toBeGreaterThanOrEqual(5);

    let totalLinks = 0;
    for (const section of sections) {
      expect(section.text).toBeTruthy();
      expect(Array.isArray(section.items)).toBe(true);

      for (const item of section.items) {
        totalLinks++;
        // item.link e.g. "/setup" or "/security/rate-limiting"
        const cleanLink = item.link.replace(/^\//, "");
        const mdPath = path.resolve(docsDir, `${cleanLink}.md`);
        const indexMdPath = path.resolve(docsDir, cleanLink, "index.md");
        const exists = fs.existsSync(mdPath) || fs.existsSync(indexMdPath);

        expect(
          exists,
          `Sidebar link "${item.link}" should point to an existing markdown file (${mdPath})`,
        ).toBe(true);
      }
    }

    expect(totalLinks).toBeGreaterThanOrEqual(15);
  });

  it("has a valid netlify.toml targeting docs/.vitepress/dist with npm run docs:build", () => {
    const netlifyPath = path.resolve(rootDir, "netlify.toml");
    expect(fs.existsSync(netlifyPath)).toBe(true);

    const netlifyContent = fs.readFileSync(netlifyPath, "utf8");
    expect(netlifyContent).toContain('command = "npm run docs:build"');
    expect(netlifyContent).toContain('publish = "docs/.vitepress/dist"');
  });

  it("includes docs build in CI quality-gate workflow", () => {
    const ciPath = path.resolve(rootDir, ".github/workflows/ci.yml");
    const ciContent = fs.readFileSync(ciPath, "utf8");
    expect(ciContent).toContain("npm run docs:build");
  });

  it("configures package.json scripts for docs:build, docs:dev, and docs:check-links", () => {
    const pkgPath = path.resolve(rootDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    expect(pkg.scripts["docs:build"]).toBe("vitepress build docs");
    expect(pkg.scripts["docs:dev"]).toBe("vitepress dev docs");
    expect(pkg.scripts["docs:check-links"]).toBe("vitepress build docs");
  });

  it("verifies homepage docs/index.md exists with hero and features", () => {
    const indexPath = path.resolve(docsDir, "index.md");
    expect(fs.existsSync(indexPath)).toBe(true);

    const indexContent = fs.readFileSync(indexPath, "utf8");
    expect(indexContent).toContain("layout: home");
    expect(indexContent).toContain("hero:");
    expect(indexContent).toContain("features:");
  });
});
