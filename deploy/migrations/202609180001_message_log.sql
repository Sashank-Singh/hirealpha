-- Every text a user sends Alpha, and what Alpha answered, in one place.
--
-- The bot's own thread files are per-number and live inside the container, so
-- they cannot answer "show me the last 500 messages where Alpha failed" and
-- they die with the volume. This is the corpus for improving the model: the
-- user's words verbatim, what Alpha replied, which engine produced it, and how
-- long it took.
--
-- Written best-effort from the turn path after the reply is delivered, so it
-- must never block or fail a turn. Reads are for the operator, not the app.
CREATE TABLE IF NOT EXISTS hire_message_log (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  phone TEXT NOT NULL,
  persona TEXT NOT NULL,
  /* 'user' for the text they sent, 'alpha' for the reply. */
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  /* Which engine wrote it: gmi, local, fallback… Null on user rows. */
  source TEXT,
  /* Groups the user's text with the reply it produced. */
  turn_id TEXT,
  reply_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two reads that matter: one conversation in order, and the newest turns
-- across everyone for review.
CREATE INDEX IF NOT EXISTS hire_message_log_phone_created_idx
  ON hire_message_log (phone, created_at DESC);

CREATE INDEX IF NOT EXISTS hire_message_log_created_idx
  ON hire_message_log (created_at DESC);
