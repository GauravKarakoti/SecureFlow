"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for failures in the root layout itself (#560).
 *
 * `src/app/error.tsx` renders *inside* the root layout, so it cannot catch a
 * throw from the layout — and the root layout is `async` and awaits `auth()`,
 * which is exactly the kind of call that fails when the session store or the
 * database is unreachable. Without this file that scenario has no boundary at
 * all.
 *
 * Because it *replaces* the root layout, it must render its own `<html>` and
 * `<body>`. It also cannot import anything that depends on the layout's
 * providers (`SessionProvider`, `ThemeProvider`) or on `./globals.css` being
 * applied, so the styling here is deliberately inline and self-contained rather
 * than reusing `ErrorState`.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] global error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0b",
          color: "#f5f5f5",
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          padding: "1.5rem",
        }}
      >
        <main
          role="alert"
          style={{ maxWidth: "32rem", textAlign: "center" }}
        >
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: "0 0 0.75rem" }}>
            SecureFlow could not start
          </h1>
          <p style={{ margin: "0 0 1.5rem", color: "#a1a1aa", lineHeight: 1.6 }}>
            A fault occurred before the application shell could render. The
            incident has been logged.
          </p>
          {error.digest ? (
            <p style={{ margin: "0 0 1.5rem", fontSize: "0.75rem", color: "#71717a" }}>
              Reference{" "}
              <code style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
                {error.digest}
              </code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              background: "#E50914",
              color: "#fff",
              border: "none",
              borderRadius: "0.5rem",
              padding: "0.625rem 1.25rem",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
