-- The retrieval index for conversational memory (mem0 + pgvector).
--
-- This extension backs recall quality, not correctness: memory_records stays
-- the encrypted system of record, and the index is a plaintext projection that
-- can be rebuilt from it. Every deletion path drops its rows.
--
-- pgvector ships with the `pgvector/pgvector:pg16` image, NOT the stock
-- `postgres:16` one. An earlier version of this migration called
-- CREATE EXTENSION unconditionally so that a missing extension would "fail
-- loudly" rather than let recall silently degrade into recency. That reasoning
-- was wrong in consequence: migrations run during boot, so the failure did not
-- degrade recall — it stopped the API from starting at all, and the whole
-- deploy rolled back. One missing index took the entire product down.
--
-- The block below keeps the signal without the outage: the extension is created
-- when the database supports it, and when it does not the migration raises a
-- warning and continues. Recall falls back to recency until the database image
-- is upgraded, which is a degraded feature rather than a dead service.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN feature_not_supported OR undefined_file OR insufficient_privilege THEN
    RAISE WARNING 'pgvector is unavailable, so the memory retrieval index is skipped. Recall falls back to recency until the database runs an image that ships pgvector (pgvector/pgvector:pg16).';
END
$$;

-- The index table is created only when the extension actually landed, so a
-- database without pgvector never carries a half-built index.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id UUID PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT '',
      embedding vector(1536) NOT NULL,
      model TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS memory_embeddings_user_idx
      ON memory_embeddings (user_id, persona);
    -- Cosine distance. Embeddings are normalized before insert, so ranking by
    -- cosine distance matches similarity without a second normalization pass.
    CREATE INDEX IF NOT EXISTS memory_embeddings_vec_idx
      ON memory_embeddings USING hnsw (embedding vector_cosine_ops);
  END IF;
END
$$;
