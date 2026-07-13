-- packages/audit-ledger/src/migrations/001_ledger_table.sql
-- Spec 07 §6.5's illustrative SQL, adapted to be idempotent (IF NOT
-- EXISTS everywhere) and safe to run against a fresh database that does
-- not yet have a `sentinel_app_role` (the REVOKE below creates it as a
-- no-login role if missing, rather than failing the migration — a real
-- deployment provisions this role with its actual login credentials out
-- of band; this migration only needs the role to exist so it can strip
-- UPDATE/DELETE from it).

CREATE TABLE IF NOT EXISTS audit_ledger (
  sequence_number  BIGSERIAL PRIMARY KEY,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type       TEXT NOT NULL,
  actor_type       TEXT NOT NULL,
  actor_id         TEXT NOT NULL,
  entity_type      TEXT,
  entity_id        TEXT,
  payload          JSONB NOT NULL,
  payload_hash     CHAR(64) NOT NULL,
  prev_entry_hash  CHAR(64) NOT NULL,
  entry_hash       CHAR(64) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_ledger_entity ON audit_ledger (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_ledger_event_type_ts ON audit_ledger (event_type, timestamp);

-- FR-32: the ledger row itself MUST NOT be updatable or deletable by the
-- application's database role — enforced at the schema level, not only
-- by application-code discipline.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_app_role') THEN
    CREATE ROLE sentinel_app_role NOLOGIN;
  END IF;
END $$;

REVOKE UPDATE, DELETE ON audit_ledger FROM sentinel_app_role;

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_ledger_no_update_delete ON audit_ledger;
CREATE TRIGGER audit_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
