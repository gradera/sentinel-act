-- packages/audit-ledger/src/migrations/002_related_obligation_id.sql
-- FR-39: a denormalized column carrying the Obligation this row concerns
-- — either because entity_ref itself IS the Obligation, or because the
-- row's own entity_ref points at something else (a HumanReview's
-- review_id, a ProcessTask's task_id) whose payload nonetheless
-- references the obligation_id it belongs to. Populated by
-- PostgresAuditLedger.append's deriveRelatedObligationId() at write
-- time (see postgres-audit-ledger.ts) — trades a small amount of
-- write-path complexity for turning `getObligationAuditTrail`'s query
-- into an indexed lookup instead of a JSONB payload scan.
ALTER TABLE audit_ledger ADD COLUMN IF NOT EXISTS related_obligation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_ledger_related_obligation
  ON audit_ledger (related_obligation_id, sequence_number);
