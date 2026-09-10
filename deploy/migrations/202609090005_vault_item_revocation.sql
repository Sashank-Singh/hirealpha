ALTER TABLE vault_items_v2 ALTER COLUMN ciphertext DROP NOT NULL;

ALTER TABLE vault_items_v2 ADD CONSTRAINT vault_item_lifecycle CHECK (
  (revoked_at IS NULL AND ciphertext IS NOT NULL)
  OR (revoked_at IS NOT NULL AND ciphertext IS NULL)
);
