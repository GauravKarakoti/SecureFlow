"use client";

import { useMemo, useState } from "react";
import { MessageSquare, Send, Trash2, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TimeAgo } from "@/components/time-ago";
import {
  addFindingNote,
  deleteFindingNote,
  MAX_NOTE_LENGTH,
  type FindingNoteDto,
} from "@/lib/actions/notes";

interface FindingNotesThreadProps {
  findingId: string;
  initialNotes: FindingNoteDto[];
  currentUserId: string;
  isAdmin: boolean;
}

/**
 * Safely parses plain text into text segments and clickable, validated HTTP/HTTPS links.
 * All non-link text is automatically escaped by React. Disallowed schemes like javascript:
 * or data: are rendered strictly as plain text.
 */
export function SafeNoteText({ text }: { text: string }) {
  const elements = useMemo(() => {
    // Regex matches http:// and https:// URLs up to whitespace or common punctuation
    const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
    const parts = text.split(urlRegex);

    return parts.map((part, index) => {
      if (/^https?:\/\//i.test(part)) {
        try {
          const parsed = new URL(part);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            return (
              <a
                key={index}
                href={parsed.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline hover:text-primary/80 break-all"
              >
                {part}
              </a>
            );
          }
        } catch {
          // If URL parsing fails, fall back to escaped text
        }
      }
      return <span key={index}>{part}</span>;
    });
  }, [text]);

  return <span className="whitespace-pre-wrap break-words">{elements}</span>;
}

export default function FindingNotesThread({
  findingId,
  initialNotes,
  currentUserId,
  isAdmin,
}: FindingNotesThreadProps) {
  const [notes, setNotes] = useState<FindingNoteDto[]>(initialNotes);
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || isSubmitting) return;

    if (trimmed.length > MAX_NOTE_LENGTH) {
      setError(`Note must be at most ${MAX_NOTE_LENGTH.toLocaleString()} characters.`);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await addFindingNote(findingId, trimmed);
      if (res.ok && res.note) {
        setNotes((prev) => [...prev, res.note!]);
        setText("");
      } else {
        setError(res.error || "Failed to add note.");
      }
    } catch {
      setError("An unexpected error occurred while adding the note.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    if (deletingId) return;
    setDeletingId(noteId);
    setError(null);

    try {
      const res = await deleteFindingNote(noteId);
      if (res.ok) {
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
      } else {
        setError(res.error || "Failed to delete note.");
      }
    } catch {
      setError("An unexpected error occurred while deleting the note.");
    } finally {
      setDeletingId(null);
    }
  };

  const charCount = text.length;
  const isOverLimit = charCount > MAX_NOTE_LENGTH;

  return (
    <div className="space-y-4 pt-6 border-t border-white/5" data-testid="finding-notes-thread">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" />
          <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Reviewer Discussion &amp; Notes ({notes.length})
          </h4>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 p-3 text-xs rounded-lg bg-red-500/10 border border-red-500/20 text-red-400"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Notes list */}
      {notes.length === 0 ? (
        <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 text-xs text-muted-foreground font-mono">
          No reviewer notes yet. Add context or ticket references below to discuss this finding.
        </div>
      ) : (
        <div className="space-y-3" data-testid="notes-list">
          {notes.map((note) => {
            const canDelete = isAdmin || note.authorId === currentUserId;
            const authorDisplayName =
              note.author.name || note.author.codename || note.author.email || "Unknown Reviewer";
            const initials = authorDisplayName.slice(0, 2).toUpperCase();

            return (
              <div
                key={note.id}
                className="p-3.5 rounded-xl bg-white/[0.02] border border-white/5 space-y-2 group transition-colors hover:border-white/10"
                data-testid={`note-item-${note.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Avatar className="h-5 w-5 shrink-0">
                      <AvatarImage src={note.author.image ?? undefined} alt={authorDisplayName} />
                      <AvatarFallback className="text-[9px]">{initials}</AvatarFallback>
                    </Avatar>
                    <span className="text-xs font-medium text-foreground truncate">
                      {authorDisplayName}
                    </span>
                    <span className="text-muted-foreground">•</span>
                    <TimeAgo
                      date={note.createdAt}
                      className="text-[11px] font-mono text-muted-foreground"
                    />
                  </div>

                  {canDelete && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      onClick={() => handleDeleteNote(note.id)}
                      disabled={deletingId === note.id}
                      title="Delete note"
                      aria-label="Delete note"
                    >
                      {deletingId === note.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                </div>

                <div className="text-xs text-muted-foreground leading-relaxed pl-7">
                  <SafeNoteText text={note.text} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add note form */}
      <form onSubmit={handleAddNote} className="space-y-2 pt-2">
        <div className="relative">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add context, justification, or references for reviewers (e.g. ticket SEC-123, vendor link)..."
            className="min-h-[80px] text-xs resize-y bg-black/40 border-white/10 focus-visible:ring-primary/40 pr-4"
            maxLength={MAX_NOTE_LENGTH}
            disabled={isSubmitting}
            aria-label="Add reviewer note"
          />
        </div>

        <div className="flex items-center justify-between">
          <span
            className={`text-[11px] font-mono ${
              isOverLimit
                ? "text-red-400 font-bold"
                : charCount > 900
                  ? "text-amber-400"
                  : "text-muted-foreground"
            }`}
          >
            {charCount.toLocaleString()} / {MAX_NOTE_LENGTH.toLocaleString()}
          </span>

          <Button
            type="submit"
            size="sm"
            disabled={!text.trim() || isOverLimit || isSubmitting}
            className="gap-1.5 h-8 text-xs"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Posting...</span>
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" />
                <span>Add Note</span>
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
