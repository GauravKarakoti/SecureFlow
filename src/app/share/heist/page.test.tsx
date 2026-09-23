import { describe, expect, it, vi } from "vitest";

vi.mock("./heist-transmission", () => ({ HeistTransmission: () => null }));

import HeistSharePage, { generateMetadata } from "./page";
import { parseHeistCardParams } from "@/lib/og/heist-card";

type Query = Record<string, string | string[] | undefined>;

async function metadataFor(query: Query) {
  return generateMetadata({ searchParams: Promise.resolve(query) });
}

async function propsFor(query: Query) {
  const element = await HeistSharePage({ searchParams: Promise.resolve(query) });
  return element.props as {
    projectName: string;
    score?: number;
    rank?: string;
    findingsCount?: number;
    tagline: string;
    imageUrl: string;
  };
}

/** The preview card's reading of the image link the page generated. */
function cardFor(imageUrl: string) {
  return parseHeistCardParams(new URL(imageUrl, "http://localhost").searchParams);
}

describe("/share/heist", () => {
  it("clamps the score the same way the preview card does", async () => {
    const metadata = await metadataFor({ score: "150", alias: "Tokyo" });
    const props = await propsFor({ score: "150" });

    expect(metadata.description).toBe("Tokyo secured the vault with a security score of 100.");
    expect(props.score).toBe(100);
    expect(cardFor(props.imageUrl).score).toBe(props.score);
  });

  it("treats a blank score as absent rather than ranking it D", async () => {
    const props = await propsFor({ score: "" });

    expect(props.score).toBeUndefined();
    expect(props.rank).toBeUndefined();
    expect(props.tagline).toBe("The vault is empty. Zero traces left behind. 🎭");
  });

  it("cleans and caps the project name in the title and the image link", async () => {
    const control = String.fromCharCode(0);
    const project = `Vault${control}${"x".repeat(200)}`;
    const metadata = await metadataFor({ project });
    const props = await propsFor({ project });

    const card = cardFor(props.imageUrl);
    expect(props.projectName).toBe(card.project);
    expect(props.projectName).toHaveLength(60);
    expect(props.projectName).not.toContain(control);
    expect(metadata.title).toBe(`Audit Passed: ${card.project} 🎭`);
  });

  it("drops a negative findings count and takes the first of repeated parameters", async () => {
    expect((await propsFor({ findingsCount: "-3" })).findingsCount).toBeUndefined();

    const props = await propsFor({ score: ["42", "99"], rank: ["a", "S"] });
    expect(props.score).toBe(42);
    expect(props.rank).toBe("A");
  });

  it("keeps an explicit rank over the one derived from the score", async () => {
    const props = await propsFor({ score: "10", rank: "s" });

    expect(props.rank).toBe("S");
    expect(props.tagline).toBe("Ghost protocol. Zero traces left behind.");
  });
});
