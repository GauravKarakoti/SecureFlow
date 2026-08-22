/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "./accordion";

describe("Accordion component", () => {
  it("renders accordion items and triggers", () => {
    render(
      <Accordion type="single" collapsible defaultValue="item-1">
        <AccordionItem value="item-1">
          <AccordionTrigger>Section 1</AccordionTrigger>
          <AccordionContent>Content 1</AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-2">
          <AccordionTrigger>Section 2</AccordionTrigger>
          <AccordionContent>Content 2</AccordionContent>
        </AccordionItem>
      </Accordion>
    );

    expect(screen.getByText("Section 1")).toBeInTheDocument();
    expect(screen.getByText("Section 2")).toBeInTheDocument();
    expect(screen.getByText("Content 1")).toBeInTheDocument();
  });

  it("expands and collapses accordion item on click", () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="item-1">
          <AccordionTrigger>Toggle Item</AccordionTrigger>
          <AccordionContent>Item Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );

    const trigger = screen.getByRole("button", { name: /toggle item/i });
    expect(trigger).toHaveAttribute("data-state", "closed");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("data-state", "open");
    expect(screen.getByText("Item Content")).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("data-state", "closed");
  });

  it("supports multiple items open when type is multiple", () => {
    render(
      <Accordion type="multiple">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger 1</AccordionTrigger>
          <AccordionContent>Content 1</AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-2">
          <AccordionTrigger>Trigger 2</AccordionTrigger>
          <AccordionContent>Content 2</AccordionContent>
        </AccordionItem>
      </Accordion>
    );

    const trigger1 = screen.getByRole("button", { name: /trigger 1/i });
    const trigger2 = screen.getByRole("button", { name: /trigger 2/i });

    fireEvent.click(trigger1);
    fireEvent.click(trigger2);

    expect(trigger1).toHaveAttribute("data-state", "open");
    expect(trigger2).toHaveAttribute("data-state", "open");
  });

  it("applies custom className to elements", () => {
    const { container } = render(
      <Accordion type="single" className="custom-accordion">
        <AccordionItem value="item-1" className="custom-item">
          <AccordionTrigger className="custom-trigger">Trigger</AccordionTrigger>
          <AccordionContent className="custom-content">Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );

    expect(container.querySelector(".custom-accordion")).toBeInTheDocument();
    expect(container.querySelector(".custom-item")).toBeInTheDocument();
    expect(container.querySelector(".custom-trigger")).toBeInTheDocument();
  });
});
