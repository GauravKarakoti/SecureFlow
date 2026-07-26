/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./card";

describe("Card components", () => {
  it("renders a complete card structure", () => {
    render(
      <Card data-testid="card-root">
        <CardHeader>
          <CardTitle>Vault Security</CardTitle>
          <CardDescription>Security Telemetry Details</CardDescription>
        </CardHeader>
        <CardContent>
          <p>Scan complete: zero breaches found.</p>
        </CardContent>
        <CardFooter>
          <span>Footer text</span>
        </CardFooter>
      </Card>
    );

    expect(screen.getByTestId("card-root")).toBeInTheDocument();
    expect(screen.getByText("Vault Security")).toBeInTheDocument();
    expect(screen.getByText("Security Telemetry Details")).toBeInTheDocument();
    expect(screen.getByText("Scan complete: zero breaches found.")).toBeInTheDocument();
    expect(screen.getByText("Footer text")).toBeInTheDocument();
  });
});
