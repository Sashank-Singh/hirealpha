ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_user_id_fkey;

COMMENT ON COLUMN audit_events.user_id IS
  'Opaque subject identifier retained for security evidence after account deletion; never an email or phone number.';
