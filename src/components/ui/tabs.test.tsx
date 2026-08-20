/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";

describe("Tabs component", () => {
  it("renders tab triggers and default active content", () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Overview</TabsTrigger>
          <TabsTrigger value="tab2">Findings</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Overview Content</TabsContent>
        <TabsContent value="tab2">Findings Content</TabsContent>
      </Tabs>
    );

    expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /findings/i })).toBeInTheDocument();
    expect(screen.getByText("Overview Content")).toBeInTheDocument();
  });

  it("renders controlled active tab content", () => {
    render(
      <Tabs value="tab2">
        <TabsList>
          <TabsTrigger value="tab1">Overview</TabsTrigger>
          <TabsTrigger value="tab2">Findings</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Overview Content</TabsContent>
        <TabsContent value="tab2">Findings Content</TabsContent>
      </Tabs>
    );

    expect(screen.getByText("Findings Content")).toBeInTheDocument();
  });

  it("applies custom classNames to tab parts", () => {
    const { container } = render(
      <Tabs defaultValue="tab1" className="custom-tabs">
        <TabsList className="custom-list">
          <TabsTrigger value="tab1" className="custom-trigger">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1" className="custom-content">Content 1</TabsContent>
      </Tabs>
    );

    expect(container.querySelector(".custom-tabs")).toBeInTheDocument();
    expect(container.querySelector(".custom-list")).toBeInTheDocument();
    expect(container.querySelector(".custom-trigger")).toBeInTheDocument();
  });
});
