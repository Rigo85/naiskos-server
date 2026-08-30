ALTER TABLE naiskos.telegram_users
  DROP CONSTRAINT telegram_users_status_check;

ALTER TABLE naiskos.telegram_users
  ADD CONSTRAINT telegram_users_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'blocked', 'revoked'));
