-- Grant premium (bundle) access to singhsashank08@gmail.com
-- Run against the hirealpha_connectors database:
--   psql $DATABASE_URL -f sql/grant-premium.sql

DO $$
DECLARE
  v_user_id TEXT;
  v_email TEXT := 'singhsashank08@gmail.com';
BEGIN
  -- Find or create the user
  SELECT id INTO v_user_id FROM hire_users WHERE email = v_email;

  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid()::text;
    INSERT INTO hire_users (id, email, name, created_at, updated_at)
    VALUES (v_user_id, v_email, 'Sashank', now(), now());
    RAISE NOTICE 'Created user % with id %', v_email, v_user_id;
  ELSE
    RAISE NOTICE 'Found existing user % with id %', v_email, v_user_id;
  END IF;

  -- Grant bundle subscription (persona = 'all' covers friend + coworker + cofounder)
  INSERT INTO hire_subscriptions (id, user_id, persona, status, price_id, current_period_end, created_at, updated_at)
  VALUES (gen_random_uuid()::text, v_user_id, 'all', 'active', 'grant_admin', now() + interval '100 years', now(), now())
  ON CONFLICT (user_id, persona) DO UPDATE SET
    status = 'active',
    price_id = 'grant_admin',
    current_period_end = now() + interval '100 years',
    updated_at = now();

  -- Add to roster for all personas
  INSERT INTO hire_roster (user_id, persona, hired_at)
  VALUES (v_user_id, 'friend', now())
  ON CONFLICT (user_id, persona) DO NOTHING;

  INSERT INTO hire_roster (user_id, persona, hired_at)
  VALUES (v_user_id, 'coworker', now())
  ON CONFLICT (user_id, persona) DO NOTHING;

  INSERT INTO hire_roster (user_id, persona, hired_at)
  VALUES (v_user_id, 'cofounder', now())
  ON CONFLICT (user_id, persona) DO NOTHING;

  RAISE NOTICE 'Granted premium bundle access to % (all hires)', v_email;
END $$;
