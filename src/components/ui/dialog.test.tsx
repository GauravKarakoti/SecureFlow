/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./dialog";

describe("Dialog component", () => {
  it("renders dialog contents when defaultOpen is true", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dialog Title</DialogTitle>
            <DialogDescription>Dialog description content.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button>Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

    expect(screen.getByText("Dialog Title")).toBeInTheDocument();
    expect(screen.getByText("Dialog description content.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("applies custom classNames to dialog parts", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent className="custom-dialog-content">
          <DialogHeader className="custom-header">
            <DialogTitle className="custom-title">Custom Title</DialogTitle>
            <DialogDescription className="custom-desc">Custom Desc</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );

    expect(screen.getByText("Custom Title")).toHaveClass("custom-title");
    expect(screen.getByText("Custom Desc")).toHaveClass("custom-desc");
  });
});
