-- packages/audit-ledger/src/migrations/003_ledger_verification_runs.sql
-- FR-36: a failing verifyChainIntegrity run MUST NOT rely solely on
-- writing "the chain is broken" back to the (possibly-compromised)
-- ledger — this side-channel table is explicitly NOT chained and NOT
-- append-only-enforced the same way (no trigger, ordinary DELETE/UPDATE
-- permitted for ops cleanup) so the failure record survives even if the
-- audit_ledger table itself is distrusted from that point forward.
CREATE TABLE IF NOT EXISTS ledger_verification_runs (
  id                            BIGSERIAL PRIMARY KEY,
  ran_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_range_start          BIGINT NOT NULL,
  verified_range_end            BIGINT NOT NULL,
  entries_checked               BIGINT NOT NULL,
  intact                        BOOLEAN NOT NULL,
  first_broken_sequence_number  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_ledger_verification_runs_ran_at ON ledger_verification_runs (ran_at);
