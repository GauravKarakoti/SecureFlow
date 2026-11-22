/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import FindingNotesThread, { SafeNoteText } from "./finding-notes-thread";
import * as notesActions from "@/lib/actions/notes";

vi.mock("@/lib/actions/notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/actions/notes")>();
  return {
    ...actual,
    addFindingNote: vi.fn(),
    deleteFindingNote: vi.fn(),
  };
});

describe("SafeNoteText component", () => {
  it("escapes raw HTML tags instead of executing them", () => {
    const malicious = "<script>alert('xss')</script><img src=x onerror=alert(1)>";
    const { container } = render(<SafeNoteText text={malicious} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(malicious);
  });

  it("converts http and https URLs into safe anchor links", () => {
    const text = "See ticket https://linear.app/issue/SEC-101 for info and http://insecure.test as well.";
    const { container } = render(<SafeNoteText text={text} />);

    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(2);

    expect(links[0]).toHaveAttribute("href", "https://linear.app/issue/SEC-101");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(links[0].textContent).toBe("https://linear.app/issue/SEC-101");

    expect(links[1]).toHaveAttribute("href", "http://insecure.test/");
    expect(links[1]).toHaveAttribute("target", "_blank");
    expect(links[1]).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not convert javascript: or data: pseudo-protocols into links", () => {
    const dangerous = "javascript:alert(1) and data:text/html;base64,PHNjcmlwdD4=";
    const { container } = render(<SafeNoteText text={dangerous} />);

    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(0);
    expect(container.textContent).toBe(dangerous);
  });
});

describe("FindingNotesThread component (#1920)", () => {
  const mockNotes: notesActions.FindingNoteDto[] = [
    {
      id: "note-1",
      findingId: "f-1",
      authorId: "user-alice",
      text: "This is a test credential in a fixture https://jira.internal/SEC-123",
      createdAt: new Date("2026-11-20T10:00:00Z"),
      updatedAt: new Date("2026-11-20T10:00:00Z"),
      author: {
        id: "user-alice",
        name: "Alice Reviewer",
        email: "alice@example.com",
        codename: "shadow-fox",
        image: null,
      },
    },
    {
      id: "note-2",
      findingId: "f-1",
      authorId: "user-bob",
      text: "Waiting for vendor patch next Tuesday.",
      createdAt: new Date("2026-11-21T12:00:00Z"),
      updatedAt: new Date("2026-11-21T12:00:00Z"),
      author: {
        id: "user-bob",
        name: "Bob Lead",
        email: "bob@example.com",
        codename: null,
        image: null,
      },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when there are no notes", () => {
    render(
      <FindingNotesThread
        findingId="f-1"
        initialNotes={[]}
        currentUserId="user-alice"
        isAdmin={false}
      />,
    );

    expect(screen.getByText(/No reviewer notes yet/i)).toBeInTheDocument();
    expect(screen.getByText("Reviewer Discussion & Notes (0)")).toBeInTheDocument();
  });

  it("renders existing notes with author name and safe link", () => {
    render(
      <FindingNotesThread
        findingId="f-1"
        initialNotes={mockNotes}
        currentUserId="user-alice"
        isAdmin={false}
      />,
    );

    expect(screen.getByText("Reviewer Discussion & Notes (2)")).toBeInTheDocument();
    expect(screen.getByText("Alice Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Bob Lead")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "https://jira.internal/SEC-123" });
    expect(link).toHaveAttribute("href", "https://jira.internal/SEC-123");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows delete button only for author or admin", () => {
    // Current user is Alice (author of note-1, but not note-2)
    const { rerender } = render(
      <FindingNotesThread
        findingId="f-1"
        initialNotes={mockNotes}
        currentUserId="user-alice"
        isAdmin={false}
      />,
    );

    const note1 = screen.getByTestId("note-item-note-1");
    const note2 = screen.getByTestId("note-item-note-2");

    // Alice should see delete button for note-1, but NOT for note-2
    expect(note1.querySelector("button[aria-label='Delete note']")).not.toBeNull();
    expect(note2.querySelector("button[aria-label='Delete note']")).toBeNull();

    // Now render as Admin: should see delete buttons for BOTH notes
    rerender(
      <FindingNotesThread
        findingId="f-1"
        initialNotes={mockNotes}
        currentUserId="user-charlie"
        isAdmin={true}
      />,
    );

    expect(note1.querySelector("button[aria-label='Delete note']")).not.toBeNull();
    expect(note2.querySelector("button[aria-label='Delete note']")).not.toBeNull();
  });

  it("enforces character limit on input and adds note", async () => {
    vi.mocked(notesActions.addFindingNote).mockResolvedValue({
      ok: true,
      note: {
        id: "note-3",
        findingId: "f-1",
        authorId: "user-alice",
        text: "New triage decision context",
        createdAt: new Date(),
        updatedAt: new Date(),
        author: {
          id: "user-alice",
          name: "Alice Reviewer",
          email: "alice@example.com",
          codename: "shadow-fox",
          image: null,
        },
      },
    });

    render(
      <FindingNotesThread
        findingId="f-1"
        initialNotes={mockNotes}
        currentUserId="user-alice"
        isAdmin={false}
      />,
    );

    const textarea = screen.getByLabelText("Add reviewer note");
    const submitBtn = screen.getByRole("button", { name: "Add Note" });

    // Submit button is disabled when empty
    expect(submitBtn).toBeDisabled();
    expect(screen.getByText("0 / 1,000")).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "New triage decision context" } });
    expect(submitBtn).not.toBeDisabled();
    expect(screen.getByText("27 / 1,000")).toBeInTheDocument();

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(notesActions.addFindingNote).toHaveBeenCalledWith(
        "f-1",
        "New triage decision context",
      );
    });

    // The new note appears in the list
    expect(await screen.findByText("New triage decision context")).toBeInTheDocument();
  });

  it("deletes note on click", async () => {
    vi.mocked(notesActions.deleteFindingNote).mockResolvedValue({ ok: true });

    render(
      <FindingNotesThread
        findingId="f-1"
        initialNotes={mockNotes}
        currentUserId="user-alice"
        isAdmin={false}
      />,
    );

    const note1 = screen.getByTestId("note-item-note-1");
    const deleteBtn = note1.querySelector("button[aria-label='Delete note']")!;

    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(notesActions.deleteFindingNote).toHaveBeenCalledWith("note-1");
    });

    // Note 1 should be removed from document
    await waitFor(() => {
      expect(screen.queryByTestId("note-item-note-1")).toBeNull();
    });
  });
});
