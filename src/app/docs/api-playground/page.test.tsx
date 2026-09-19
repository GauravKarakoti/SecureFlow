/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import ApiPlaygroundPage, { metadata } from "./page";

// Swagger UI pulls in several megabytes of bundle and touches `window` on
// import, neither of which says anything about this page. The seam under test
// is the prop: the page must point the explorer at the live spec route.
vi.mock("@/components/docs/api-playground", () => ({
  ApiPlayground: ({ specUrl }: { specUrl: string }) => (
    <div data-testid="api-playground" data-spec-url={specUrl} />
  ),
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

describe("/docs/api-playground", () => {
  it("renders the explorer against the live spec route", () => {
    render(<ApiPlaygroundPage />);

    const playground = screen.getByTestId("api-playground");
    // Not `/openapi.yaml`: a static copy under `public/` is the staleness this
    // page exists to avoid.
    expect(playground).toHaveAttribute("data-spec-url", "/api/openapi");
  });

  it("warns that requests are real before anyone presses Execute", () => {
    render(<ApiPlaygroundPage />);

    expect(screen.getByText(/requests you send here are real/i)).toBeInTheDocument();
  });

  it("says webhook routes cannot be signed from the browser", () => {
    render(<ApiPlaygroundPage />);

    expect(screen.getByText(/hmac signature that the browser cannot compute/i)).toBeInTheDocument();
  });

  it("links back to the written documentation", () => {
    render(<ApiPlaygroundPage />);

    expect(screen.getByRole("link", { name: /documentation/i })).toHaveAttribute("href", "/docs");
  });

  it("titles the page for the browser tab", () => {
    expect(metadata.title).toBe("API Playground | SecureFlow");
  });
});
