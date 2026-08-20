/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Alert, AlertTitle, AlertDescription } from "./alert";

describe("Alert component", () => {
  it("renders alert with title and description", () => {
    render(
      <Alert>
        <AlertTitle>Security Warning</AlertTitle>
        <AlertDescription>Secret leaked in commit.</AlertDescription>
      </Alert>
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Security Warning")).toBeInTheDocument();
    expect(screen.getByText("Secret leaked in commit.")).toBeInTheDocument();
  });

  it("applies default variant styles", () => {
    render(
      <Alert>
        <AlertTitle>Default</AlertTitle>
      </Alert>
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("bg-background");
    expect(alert).toHaveClass("text-foreground");
  });

  it("applies destructive variant styles", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Critical Alert</AlertTitle>
      </Alert>
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("text-destructive");
  });

  it("merges custom classNames properly", () => {
    render(
      <Alert className="custom-alert-class">
        <AlertTitle className="custom-title-class">Title</AlertTitle>
        <AlertDescription className="custom-desc-class">Desc</AlertDescription>
      </Alert>
    );

    expect(screen.getByRole("alert")).toHaveClass("custom-alert-class");
    expect(screen.getByText("Title")).toHaveClass("custom-title-class");
    expect(screen.getByText("Desc")).toHaveClass("custom-desc-class");
  });
});
