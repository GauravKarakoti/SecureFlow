/**
 * @vitest-environment jsdom
 */
// mermaid needs a DOM (DOMPurify) to parse. The VitePress config is checked in
// docs-build.test.ts instead, because vitepress cannot be imported under jsdom.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import mermaid from "mermaid";

const docsDir = path.resolve(__dirname, "..", "docs");

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

/** Every ```mermaid fence in docs/, with its file and starting line for error messages. */
function mermaidBlocks() {
  const blocks: { file: string; line: number; code: string }[] = [];
  for (const file of markdownFiles(docsDir)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== "```mermaid") continue;
      const line = i + 1;
      const body: string[] = [];
      for (i++; i < lines.length && lines[i].trim() !== "```"; i++) body.push(lines[i]);
      blocks.push({ file: path.relative(docsDir, file), line, code: body.join("\n") });
    }
  }
  return blocks;
}

describe("Mermaid diagrams in the docs (#2178)", () => {
  it("finds the diagrams in architecture.md and threat-model.md", () => {
    const files = mermaidBlocks().map((b) => b.file);
    expect(files.filter((f) => f === "architecture.md")).toHaveLength(4);
    expect(files.filter((f) => f === "threat-model.md")).toHaveLength(1);
  });

  it("every mermaid block parses, so it renders on the docs site and on GitHub", async () => {
    mermaid.initialize({ startOnLoad: false });
    for (const { file, line, code } of mermaidBlocks()) {
      await expect(
        mermaid.parse(code),
        `mermaid block at docs/${file}:${line}`,
      ).resolves.toBeTruthy();
    }
  });
});
