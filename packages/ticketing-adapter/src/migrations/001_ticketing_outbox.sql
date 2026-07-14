-- packages/ticketing-adapter/src/migrations/001_ticketing_outbox.sql
-- Spec 13 §4.4/§6.5's outbox + ticket-mapping tables, adapted to be
-- idempotent (IF NOT EXISTS everywhere) and safe to run repeatedly.

CREATE TABLE IF NOT EXISTS ticketing_outbox (
  id               UUID PRIMARY KEY,
  event_id         TEXT NOT NULL UNIQUE, -- FR-3: dedupes a redelivered ObligationCommittedEvent
  obligation_id    TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  -- See TicketingOutboxEntry.tier's doc comment in src/types.ts: persisted
  -- here (deviation from spec §4.4's literal column list) because
  -- buildCreateTicketRequest needs event.tier for FR-12 labels, and it
  -- cannot be reliably re-derived from Obligation.status alone once
  -- committed (Tier B and Tier C both collapse to "committed").
  tier             TEXT NOT NULL CHECK (tier IN ('A', 'B', 'C', 'ESCALATE')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'succeeded', 'failed_retryable', 'failed_permanent')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FR-13's claim query: status IN (...) AND next_attempt_at <= now(),
-- ordered by created_at ascending.
CREATE INDEX IF NOT EXISTS idx_ticketing_outbox_claimable
  ON ticketing_outbox (status, next_attempt_at, created_at);

-- FR-19's reconciliation sweep needs "any in-flight outbox row for this
-- task_id" to be a cheap lookup.
CREATE INDEX IF NOT EXISTS idx_ticketing_outbox_task_status
  ON ticketing_outbox (task_id, status);

CREATE TABLE IF NOT EXISTS ticket_mapping (
  task_id              TEXT PRIMARY KEY, -- FR-4: at most one ticket per ProcessTask, ever
  adapter_name         TEXT NOT NULL,
  external_ticket_id   TEXT NOT NULL,
  external_ticket_url  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ticketing_outbox_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticketing_outbox_touch_updated_at ON ticketing_outbox;
CREATE TRIGGER ticketing_outbox_touch_updated_at
  BEFORE UPDATE ON ticketing_outbox
  FOR EACH ROW EXECUTE FUNCTION ticketing_outbox_set_updated_at();
