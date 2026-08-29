-- Supports the per-user filter aggregates on /dashboard/audit (#659).
--
-- getUserAuditLogFilters() groups AuditLog by `action` and by `decision` for a
-- single user. AuditLog already has (userId) and (userId, timestamp DESC), but
-- neither helps here, so both aggregates scanned the user's rows and sorted
-- them to produce a list of a dozen strings.

-- CreateIndex
CREATE INDEX "AuditLog_userId_action_idx" ON "AuditLog"("userId", "action");

-- CreateIndex
CREATE INDEX "AuditLog_userId_decision_idx" ON "AuditLog"("userId", "decision");
