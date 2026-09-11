-- memory_records becomes the system of record for the structured facts that
-- previously lived in the plaintext hire_memories table. Facts are keyed per
-- persona (README: "strict memory partitions"), so a fact needs a stable key
-- to upsert on and a durable flag to match the existing expiry rules.
--
-- memory_key is nullable on purpose: consented free-form memories (the
-- original purpose of this table) have no key. The partial unique index below
-- therefore only constrains keyed facts, and it excludes crypto-shredded rows
-- so a re-stated fact after deletion inserts a fresh record instead of
-- resurrecting a tombstone.
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS persona TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS memory_key TEXT;
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS durable BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS memory_records_fact_idx
  ON memory_records (user_id, persona, memory_key)
  WHERE memory_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS memory_records_persona_idx
  ON memory_records (user_id, persona, durable, created_at DESC)
  WHERE deleted_at IS NULL;
