---
"secureflow": patch
---

Make the DLQ auto-retry limit and backoff apply. A requeued webhook that failed again re-entered the DLQ as a first-time entry: the count was not carried, so it was requeued on every poll without end. The count now travels on the requeued job, and the worker writes it back onto the new DLQ entry. Separately, a failed `remove()` no longer re-inserts a duplicate entry.
