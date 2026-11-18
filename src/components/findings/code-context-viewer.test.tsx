/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { CodeContextViewer } from "./code-context-viewer";

describe("CodeContextViewer Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("handles missing code context gracefully with empty state", () => {
    render(<CodeContextViewer codeSnippet={null} />);

    expect(screen.getByTestId("code-context-empty")).toBeInTheDocument();
    expect(screen.getByText("Code snippet unavailable.")).toBeInTheDocument();
    expect(
      screen.getByText("No source code context was captured for this finding during the scan."),
    ).toBeInTheDocument();
  });

  it("handles empty whitespace string gracefully", () => {
    render(<CodeContextViewer codeSnippet="   \n  " />);

    expect(screen.getByTestId("code-context-empty")).toBeInTheDocument();
    expect(screen.getByText("Code snippet unavailable.")).toBeInTheDocument();
  });

  it("renders lines with line numbers starting from lineStart", () => {
    const code = "line one\nline two\nline three";
    render(
      <CodeContextViewer
        codeSnippet={code}
        lineStart={10}
        lineEnd={11}
        fileLocation="src/auth/login.ts"
      />,
    );

    expect(screen.getByText("login.ts")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("11")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("line one")).toBeInTheDocument();
    expect(screen.getByText("line two")).toBeInTheDocument();
    expect(screen.getByText("line three")).toBeInTheDocument();
  });

  it("highlights affected lines correctly with data-highlighted=true", () => {
    const code = "safe before\nvulnerable line 1\nvulnerable line 2\nsafe after";
    render(
      <CodeContextViewer
        codeSnippet={code}
        lineStart={20}
        lineEnd={21}
        fileLocation="src/server.ts"
      />,
    );

    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(4);

    expect(rows[0]).toHaveAttribute("data-highlighted", "true"); // line 20
    expect(rows[1]).toHaveAttribute("data-highlighted", "true"); // line 21
    expect(rows[2]).toHaveAttribute("data-highlighted", "false"); // line 22
    expect(rows[3]).toHaveAttribute("data-highlighted", "false"); // line 23
  });

  it("masks secrets in the displayed code snippet", () => {
    const code = 'const token = "sk-ant-api03-abcdef1234567890abcdef12345678901234";';
    render(<CodeContextViewer codeSnippet={code} fileLocation="src/keys.ts" />);

    expect(screen.queryByText(/sk-ant-api03/)).not.toBeInTheDocument();
    expect(screen.getByText(/REDACTED/i)).toBeInTheDocument();
  });

  it("copies source code snippet on copy button click", async () => {
    vi.useFakeTimers();
    const code = "console.log('hello');";
    render(<CodeContextViewer codeSnippet={code} />);

    const copyBtn = screen.getByRole("button", { name: "Copy source code snippet" });
    expect(copyBtn).toHaveTextContent("Copy Code");

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code);
    expect(screen.getByText("Copied")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByText("Copy Code")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
