import { describe, it, expect } from "vitest";
import { generateBadgeSvg, type BadgeState } from "./badge";

describe("generateBadgeSvg", () => {
  const states: BadgeState[] = ["passing", "review required", "blocked", "unknown"];

  it.each(states)("generates valid SVG for state '%s'", (state) => {
    const svg = generateBadgeSvg(state);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("</svg>");
    expect(svg).toContain("SecureFlow");
    expect(svg).toContain(state);
  });

  it("uses green for passing", () => {
    expect(generateBadgeSvg("passing")).toContain("#4c1");
  });

  it("uses yellow for review required", () => {
    expect(generateBadgeSvg("review required")).toContain("#dfb317");
  });

  it("uses red for blocked", () => {
    expect(generateBadgeSvg("blocked")).toContain("#e05d44");
  });

  it("uses grey for unknown", () => {
    expect(generateBadgeSvg("unknown")).toContain("#9f9f9f");
  });

  it("includes ARIA label for accessibility", () => {
    const svg = generateBadgeSvg("passing");
    expect(svg).toContain('aria-label="SecureFlow: passing"');
  });

  it("includes a <title> element", () => {
    const svg = generateBadgeSvg("blocked");
    expect(svg).toContain("<title>SecureFlow: blocked</title>");
  });
});
