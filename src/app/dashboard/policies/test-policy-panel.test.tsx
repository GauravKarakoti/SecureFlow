/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestPolicyPanel } from "./test-policy-panel";

const { mockToast } = vi.hoisted(() => ({
  mockToast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: mockToast,
}));

describe("TestPolicyPanel Component", () => {
  const policies = [
    {
      id: "pol-1",
      name: "No Secrets",
      description: "Disallows hardcoded tokens or API keys",
    },
    {
      id: "pol-2",
      name: "SQL Injection Guard",
      description: "Flags unparameterized database queries",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with initial policy template pre-selected and empty snippet", () => {
    render(<TestPolicyPanel policies={policies} />);

    expect(screen.getByText("Test Policy (Playground)")).toBeInTheDocument();
    const descInput = screen.getByLabelText("Policy rule description") as HTMLInputElement;
    expect(descInput.value).toBe("Disallows hardcoded tokens or API keys");

    const snippetTextarea = screen.getByLabelText("Code snippet") as HTMLTextAreaElement;
    expect(snippetTextarea.value).toBe("");
  });

  it("shows an error toast if user clicks test with an empty snippet", async () => {
    render(<TestPolicyPanel policies={policies} />);

    const runBtn = screen.getByRole("button", { name: /Test Policy/i });
    expect(runBtn).toBeDisabled();
  });

  it("calls /api/policies/test and displays findings when match occurs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        findingsCount: 1,
        findings: [
          {
            type: "Secret",
            severity: "CRITICAL",
            description: "Hardcoded API Token detected",
            fileLocation: "example.ts",
            lineStart: 1,
          },
        ],
      }),
    } as any);

    render(<TestPolicyPanel policies={policies} />);

    const snippetTextarea = screen.getByLabelText("Code snippet");
    await userEvent.type(snippetTextarea, "const apiKey = 'sk_test_123';");

    const runBtn = screen.getByRole("button", { name: /Test Policy/i });
    expect(runBtn).not.toBeDisabled();
    await userEvent.click(runBtn);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/policies/test",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            policyDescription: "Disallows hardcoded tokens or API keys",
            snippet: "const apiKey = 'sk_test_123';",
            filename: "example.ts",
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Hardcoded API Token detected")).toBeInTheDocument();
      expect(screen.getByText("Secret")).toBeInTheDocument();
      expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining("Matched 1 finding"));
    });
  });

  it("displays clean state message when no findings are returned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        findingsCount: 0,
        findings: [],
      }),
    } as any);

    render(<TestPolicyPanel policies={policies} />);

    const snippetTextarea = screen.getByLabelText("Code snippet");
    await userEvent.type(snippetTextarea, "const cleanNumber = 42;");

    const runBtn = screen.getByRole("button", { name: /Test Policy/i });
    await userEvent.click(runBtn);

    await waitFor(() => {
      expect(screen.getByText("No findings detected")).toBeInTheDocument();
      expect(mockToast.success).toHaveBeenCalledWith(
        expect.stringContaining("No violations found"),
      );
    });
  });
});
