import type { SQL } from "bun"
import { sweepExpiredArtifacts, artifactsRoot } from "../workshop"
import { ensureBrowserVaultSchema } from "../browserVault"
import { ensureUserPaymentsSchema } from "../userPayments"
import { ensureBrowserJobsSchema } from "../browserJobs"

/** Turn an existing unique index into a table UNIQUE constraint when missing. */
export async function ensureUniqueConstraint(
  sql: SQL,
  table: string,
  constraint: string,
  index: string,
  columns: string,
) {
  const existing = (await sql`
    SELECT 1 FROM pg_constraint WHERE conname = ${constraint} LIMIT 1
  `) as Array<unknown>
  if (existing.length) return
  const unsafe = sql as SQL & { unsafe: (query: string) => Promise<unknown> }
  try {
    await unsafe.unsafe(
      `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} UNIQUE USING INDEX ${index}`,
    )
  } catch {
    try {
      await unsafe.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} UNIQUE (${columns})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/already exists|duplicate/i.test(msg)) {
        console.warn(`[hire] unique constraint ${constraint}`, msg)
      }
    }
  }
}

/**
 * Chat memory retention. Off by default: nothing is ever deleted unless
 * RETENTION_DAYS is set to a positive number of days, and then only
 * hire_memories rows untouched for that long go. Runs from ensureHireSchema,
 * next to the artifact sweep.
 */
export async function purgeExpiredChatData(sql: SQL) {
  const days = Number(process.env.RETENTION_DAYS || "")
  if (!Number.isFinite(days) || days <= 0) return
  await sql`DELETE FROM hire_memories WHERE updated_at < now() - make_interval(days => ${days})`
}

export async function ensureHireSchema(sql: SQL) {
  await sql`
    CREATE TABLE IF NOT EXISTS hire_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      timezone TEXT,
      phone_e164 TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS name TEXT`
  await sql`ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS assigned_phone TEXT`
  await sql`ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS timezone TEXT`
  await sql`ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS password_hash TEXT`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_reminders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      text TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      recurrence TEXT NOT NULL DEFAULT 'once',
      timezone TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_reminders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_reminders_due ON hire_reminders (persona, status, scheduled_at)`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_roster (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      hired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_context (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_google_tokens (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      scopes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_oauth_state (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      redirect_after TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_composio_auth (
      toolkit TEXT PRIMARY KEY,
      auth_config_id TEXT NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_login_tickets (
      ticket TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      phone_e164 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_login_tickets ADD COLUMN IF NOT EXISTS name TEXT`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_event_inbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT 'friend',
      topic TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      urgent BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_event_inbox_due ON hire_event_inbox (persona, status, created_at ASC)`
  await sql`ALTER TABLE hire_roster ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_memories (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      durable BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona, key)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_memories_user ON hire_memories (user_id, persona, durable, updated_at DESC)`

  /* Deletion has to reach the bot, or a memory removed in the dashboard keeps
   * being injected from the container-local file until the container happens to
   * be recreated. A tombstone is how the bot can tell "never stored" (push it
   * again) from "the user deleted it" (drop it): the live payload carries the
   * recent keys and the turn prunes them locally. Re-stating the fact clears
   * its tombstone. */
  await sql`
    CREATE TABLE IF NOT EXISTS hire_memory_tombstones (
      user_id TEXT NOT NULL,
      persona TEXT NOT NULL,
      key TEXT NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona, key)
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_loops (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      due_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_loops_user ON hire_loops (user_id, status, created_at DESC)`

  /* The LLM judgment layer's cache: one row per user holding the verdicts for
   * their current mail batch and today's meetings, rebuilt at most every 15
   * minutes so opening a brief costs zero model calls. */
  await sql`
    CREATE TABLE IF NOT EXISTS hire_judge_cache (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      day TEXT NOT NULL,
      built_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_decisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      review_at TIMESTAMPTZ,
      outcome TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_decisions_user ON hire_decisions (user_id, status, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_relationships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      notes TEXT NOT NULL DEFAULT '',
      cadence_days INTEGER NOT NULL DEFAULT 30,
      last_touch_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_relationships_user ON hire_relationships (user_id, updated_at DESC)`

  // Heal: prod's hire_relationships predates last_touch_at (CREATE IF NOT
  // EXISTS never adds columns), and the radar queries read it — the 42703
  // "column does not exist" behind judgment-state and home load failures.
  await sql`ALTER TABLE hire_relationships ADD COLUMN IF NOT EXISTS last_touch_at TIMESTAMPTZ`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_dropzone (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      media_kind TEXT,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_standups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, day)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_runway_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      taken_on TEXT NOT NULL,
      cash REAL NOT NULL DEFAULT 0,
      burn REAL NOT NULL DEFAULT 0,
      months REAL NOT NULL DEFAULT 0,
      UNIQUE (user_id, taken_on)
    )
  `
  /* Workshop: things Alpha builds. Delivered artifacts auto-expire (7 days)
   * unless the user keeps them — nothing the sandbox makes persists by default. */
  await sql`
    CREATE TABLE IF NOT EXISTS hire_artifacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'page',
      files JSONB NOT NULL DEFAULT '[]'::jsonb,
      state TEXT NOT NULL DEFAULT 'delivered',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  /* Build files live in the database, not on the container disk: a deploy
   * replaces the container and every build made before it would vanish. */
  await sql`
    CREATE TABLE IF NOT EXISTS hire_artifact_files (
      artifact_id TEXT NOT NULL REFERENCES hire_artifacts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (artifact_id, name)
    )
  `
  /* Dedup: one verified build serves every user who asks for the same thing.
   * template_key is the normalized ask; clones copy the files per user so
   * expiry and keep/toss stay personal. */
  await sql`ALTER TABLE hire_artifacts ADD COLUMN IF NOT EXISTS template_key TEXT`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_artifacts_template ON hire_artifacts (template_key, created_at DESC)`
  // Templates built before the phone-gate fix (2026-08-28) teach keyboard-only
  // apps to every future clone — ping pong shipped arrow keys to an iPhone.
  // Invalidate the old cache; new verified builds repopulate it.
  await sql`UPDATE hire_artifacts SET template_key = NULL WHERE template_key IS NOT NULL AND created_at < '2026-08-28'`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_workshop_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      error TEXT,
      artifact_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_dropzone_user ON hire_dropzone (user_id, status, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_meetings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      starts_at TIMESTAMPTZ,
      phase TEXT NOT NULL DEFAULT 'prep',
      briefing TEXT,
      followups JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_meetings_user ON hire_meetings (user_id, created_at DESC)`
  await sql`ALTER TABLE hire_meetings ADD COLUMN IF NOT EXISTS notes TEXT`
  /* The busy-now guard reads ends_at (below), and the column was never added:
   * `INSERT INTO hire_meetings` writes starts_at only, so the query threw
   * `column "ends_at" does not exist` every poll — caught, so the guard was
   * silently dead and the database log filled with the same error every ten
   * seconds (founder's paste, 2026-09-21 15:43). */
  await sql`ALTER TABLE hire_meetings ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'email',
      to_addr TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS thread_id TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS in_reply_to TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS start_at TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS end_at TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS provider_id TEXT`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS operation_key TEXT`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS source_message_id TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`
  await sql`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS hire_drafts_pending_operation_idx ON hire_drafts (user_id, operation_key) WHERE operation_key IS NOT NULL AND status IN ('pending', 'sending', 'booking', 'outcome_unknown')`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_drafts_user ON hire_drafts (user_id, status, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_nudge_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      nudge_key TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, nudge_key)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_nudge_log_user ON hire_nudge_log (user_id, persona, sent_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_nutrition_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      image_url TEXT,
      calories REAL NOT NULL DEFAULT 0,
      protein REAL NOT NULL DEFAULT 0,
      carbs REAL NOT NULL DEFAULT 0,
      fat REAL NOT NULL DEFAULT 0,
      eaten_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_nutrition_user ON hire_nutrition_logs (user_id, eaten_at DESC)`

  /* The brief is the one screen Alpha texts a link to, and building it costs a
   * calendar fetch, an inbox pull, and a model pass. The in-memory cache loses
   * everything on a deploy, so the last build is persisted here per day: a cold
   * container can serve today's brief on the spot and rebuild behind it. */
  await sql`
    CREATE TABLE IF NOT EXISTS hire_brief_cache (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      kind TEXT NOT NULL,
      day TEXT NOT NULL,
      payload TEXT NOT NULL,
      built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona, kind)
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_nutrition_goals (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      calorie_goal REAL NOT NULL DEFAULT 2200,
      protein_goal REAL NOT NULL DEFAULT 150,
      carbs_goal REAL NOT NULL DEFAULT 220,
      fat_goal REAL NOT NULL DEFAULT 70,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_habits (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '💪',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_habits_user ON hire_habits (user_id)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_habit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      habit_id TEXT NOT NULL REFERENCES hire_habits(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_habit_logs_unique ON hire_habit_logs (habit_id, date)`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_habit_logs_user ON hire_habit_logs (user_id, date)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_moods (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      energy INTEGER NOT NULL DEFAULT 3,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_moods_user ON hire_moods (user_id, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_workouts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      exercise TEXT NOT NULL,
      sets INTEGER NOT NULL DEFAULT 1,
      reps INTEGER NOT NULL DEFAULT 1,
      weight REAL NOT NULL DEFAULT 0,
      notes TEXT,
      logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_workouts_user ON hire_workouts (user_id, logged_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_learning (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT,
      kind TEXT NOT NULL DEFAULT 'article',
      minutes INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_learning_user ON hire_learning (user_id, created_at DESC)`
  await sql`ALTER TABLE hire_learning ADD COLUMN IF NOT EXISTS notes TEXT`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_weekly_reviews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      week_start TEXT NOT NULL,
      done_text TEXT NOT NULL DEFAULT '',
      slipped_text TEXT NOT NULL DEFAULT '',
      focus_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_weekly_reviews_week ON hire_weekly_reviews (user_id, week_start)`
  await ensureUniqueConstraint(sql, 'hire_weekly_reviews', 'hire_weekly_reviews_user_week', 'idx_hire_weekly_reviews_week', 'user_id, week_start')

  await sql`
    CREATE TABLE IF NOT EXISTS hire_network (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      where_met TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      last_touch TIMESTAMPTZ,
      cadence_days INTEGER NOT NULL DEFAULT 14,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_network_user ON hire_network (user_id, last_touch)`
  await sql`ALTER TABLE hire_network ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_network ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_network ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT ''`
  // Backlog #33: a person's birthday (YYYY-MM-DD) arms the friend hire's
  // yearly birthday touch. Nullable on purpose: most contacts have no date
  // on file, and the reminder only ever fires off a real stored value.
  await sql`ALTER TABLE hire_network ADD COLUMN IF NOT EXISTS birthday DATE`

  /* One people list, not two. The Relationship Radar used to keep its own
   * table so the mini app and the CRM could disagree about the same person —
   * that split-brain is gone now, and these legacy rows move over once. The old
   * table stays in place (never dropped) so nothing breaks mid-migration. */
  await sql`
    INSERT INTO hire_network (id, user_id, name, where_met, context, cadence_days, last_touch, created_at)
    SELECT r.id, r.user_id, r.name, '', r.notes, r.cadence_days, r.last_touch_at, r.created_at
    FROM hire_relationships r
    WHERE r.id NOT IN (SELECT id FROM hire_network WHERE user_id = r.user_id)
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_sleep (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      sleep_date TEXT NOT NULL,
      bedtime TEXT NOT NULL,
      wake TEXT NOT NULL,
      quality INTEGER NOT NULL DEFAULT 3,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_sleep_day ON hire_sleep (user_id, sleep_date)`
  await ensureUniqueConstraint(sql, 'hire_sleep', 'hire_sleep_user_night', 'idx_hire_sleep_day', 'user_id, sleep_date')
  await sql`ALTER TABLE hire_sleep ADD COLUMN IF NOT EXISTS source TEXT`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_pipeline (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT 'lead',
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_pipeline_user ON hire_pipeline (user_id, updated_at DESC)`
  await sql`ALTER TABLE hire_pipeline ADD COLUMN IF NOT EXISTS value REAL NOT NULL DEFAULT 0`
  await sql`ALTER TABLE hire_pipeline ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'deal'`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_gratitude (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_gratitude_user ON hire_gratitude (user_id, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_spending (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      description TEXT NOT NULL DEFAULT '',
      spent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_spending_user ON hire_spending (user_id, spent_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_spending_budget (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      weekly_budget REAL NOT NULL DEFAULT 400,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_user_locations (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('current', 'home', 'work')),
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      accuracy_m REAL,
      label TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, kind)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_user_locations_user ON hire_user_locations (user_id, updated_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_mini_prefs (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      workout_place TEXT NOT NULL DEFAULT 'gym',
      workout_move_count INTEGER NOT NULL DEFAULT 4,
      workout_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
      sleep_bedtime TEXT NOT NULL DEFAULT '23:00',
      sleep_wake TEXT NOT NULL DEFAULT '07:00',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_mini_prefs ADD COLUMN IF NOT EXISTS current_weight_lb REAL`
  await sql`ALTER TABLE hire_mini_prefs ADD COLUMN IF NOT EXISTS target_weight_lb REAL`
  await sql`ALTER TABLE hire_mini_prefs ADD COLUMN IF NOT EXISTS weight_goal TEXT`
  await sql`ALTER TABLE hire_mini_prefs ADD COLUMN IF NOT EXISTS workout_move_count INTEGER NOT NULL DEFAULT 4`
  await sql`ALTER TABLE hire_mini_prefs ADD COLUMN IF NOT EXISTS workout_days TEXT NOT NULL DEFAULT '1,2,3,4,5'`

  // The mail kinds this user's own inbox has produced. The judge names a pile per
  // mail; storing the names is what stops the brief's group headers reshuffling
  // every run, because last week's names are offered back as the preferred set.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_mail_kinds (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, kind)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_mail_kinds_top ON hire_mail_kinds (user_id, uses DESC)`

  // Triage actions from the brief: done, skip, drafted, opened. Skip is the
  // learning signal — two skips on a sender bury its future picks; replies and
  // drafts promote it. One row per action so history is replayable.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_mail_feedback (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      gmail_id TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_mail_feedback_user ON hire_mail_feedback (user_id, sender, created_at DESC)`

  // Signups that gave a phone number wait here for a bot to text them first.
  // Bots claim rows over the internal API, attempt the intro, and ack; failed
  // claims keep attempts so Photon lines that cannot cold-text a target do not
  // retry forever — the signup screen tells the person to text first instead.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_intro_queue (
      id TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      persona TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      UNIQUE (phone_e164, persona)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_intro_queue_due ON hire_intro_queue (persona, status, attempts, created_at)`

  // Phone numbers that asked for a hire that is not live yet. Not the intro
  // queue: nobody texts them today. This is the launch-day list — when a
  // persona flips live, these rows convert to intro-queue entries.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_soon_waitlist (
      phone_e164 TEXT NOT NULL,
      persona TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (phone_e164, persona)
    )
  `

  // Billing. One row per user+persona; checked out through Stripe, state kept
  // here so the bots and the dashboard can read entitlements without calling
  // Stripe on every request.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'incomplete',
      price_id TEXT,
      current_period_end TIMESTAMPTZ,
      promo_started_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, persona)
    )
  `
  await sql`ALTER TABLE hire_subscriptions ADD COLUMN IF NOT EXISTS promo_started_at TIMESTAMPTZ`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_subscriptions_user ON hire_subscriptions (user_id, status)`

  // Proactive jobs a hire runs on a schedule. status walks pending → running →
  // done, with paused and failed as parking states; attempts mirrors the intro
  // queue so a flapping job stops after TASK_LOOP_MAX_ATTEMPTS. One row per
  // (user, persona, kind) keeps seeded defaults and handoffs from piling up.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT 'friend',
      kind TEXT NOT NULL CHECK (kind IN ('subscription_cancel','reservation','flight_check_in')),
      target TEXT NOT NULL,
      target_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_authorization','executing','verification_pending','completed','failed','outcome_unknown','cancellation_requested','cancelled')),
      provider TEXT,
      requested_terms JSONB NOT NULL DEFAULT '{}'::jsonb,
      approved_terms JSONB,
      browser_job_id UUID,
      verification_method TEXT,
      external_receipt JSONB,
      external_object_id TEXT,
      result_summary TEXT,
      failure_reason TEXT,
      blocker JSONB,
      attempt_count INT NOT NULL DEFAULT 0,
      verified_at TIMESTAMPTZ,
      next_verify_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_operations_active
      ON hire_operations (user_id, persona, kind, target_key)
      WHERE status NOT IN ('failed','cancelled')
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_operations_user ON hire_operations (user_id, persona, updated_at DESC)`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_completions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT 'friend',
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      target_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      requested_terms JSONB NOT NULL DEFAULT '{}'::jsonb,
      approved_terms JSONB,
      executor TEXT,
      executor_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      verification JSONB,
      external_object_id TEXT,
      result_summary TEXT,
      failure_reason TEXT,
      blocker JSONB,
      receipt JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT 'friend',
      goal TEXT NOT NULL,
      steps JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      blocker TEXT,
      operation_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
      next_action TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, persona, goal)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_completions_active ON hire_completions (user_id, persona, state) WHERE state NOT IN ('completed','failed','cancelled')`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_task_loops (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run TIMESTAMPTZ,
      last_result TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, persona, kind)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_task_loops_due ON hire_task_loops (persona, status, next_run)`

  // Invite codes handed out by an armed phone. The referrer is the row owner;
  // a redemption records who came in through the code.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_invites (
      code TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      redeemed_by_phone TEXT,
      redeemed_at TIMESTAMPTZ
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_invites_phone ON hire_invites (phone_e164)`

  // Referral ledger: every full set of three redeemed invite codes earns the
  // referrer one free month (id `${phone}:${n}` keeps the rows idempotent).
  await sql`
    CREATE TABLE IF NOT EXISTS hire_referral_rewards (
      id TEXT PRIMARY KEY,
      referrer_phone TEXT NOT NULL,
      reward TEXT NOT NULL DEFAULT 'free_month',
      friends_hired INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'earned',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_referral_rewards_phone ON hire_referral_rewards (referrer_phone)`

  // Referral credits: one free month per redeemed invite code, spent as a
  // 100% off coupon on the referrer's next checkout. source_code UNIQUE makes
  // the ledger idempotent (codes are single-use, so re-redeem cannot double
  // credit); used_at marks a credit spent at checkout.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_referral_credits (
      id TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      source_code TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      used_at TIMESTAMPTZ,
      used_for_persona TEXT
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_referral_credits_phone ON hire_referral_credits (phone_e164)`

  // Receipts for things a hire actually did on the user's behalf, one row per
  // action with an optional undo hint for the client to render.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_action_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      undo_hint TEXT,
      undone_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_action_log_user ON hire_action_log (user_id, created_at DESC)`

  // A person can silence a hire before it texts: bots check this before every
  // proactive send.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_kill_switch (
      phone_e164 TEXT PRIMARY KEY,
      armed BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  // Feature votes. One vote per phone per idea keeps the tally honest.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_wishlist (
      id TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      vote TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (phone_e164, vote)
    )
  `

  // Status page: each hire beats here after its replies so /api/status can say
  // who is up without the bots exposing their hosts.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_heartbeat (
      persona TEXT PRIMARY KEY,
      last_beat TIMESTAMPTZ NOT NULL DEFAULT now(),
      reply_ms INTEGER
    )
  `

  // Delivered-but-unkept artifacts die with the day count; the sweep also runs
  // hourly from the server so a long-lived process keeps purging.
  try {
    await sweepExpiredArtifacts(sql, artifactsRoot())
  } catch {
    /* first boot may have no dir yet */
  }
  // Chat memory retention, same cadence as the artifact sweep: every
  // ensureHireSchema pass (boot and each deploy restart). Off unless
  // RETENTION_DAYS is set to a positive number of days.
  try {
    await purgeExpiredChatData(sql)
  } catch (err) {
    console.warn('[hire] retention purge failed', err)
  }
  // Credential vault + browser-approval gates (per-user, per-portal, encrypted).
  await ensureBrowserVaultSchema(sql)
  await ensureUserPaymentsSchema(sql)
  await ensureBrowserJobsSchema(sql)
}
