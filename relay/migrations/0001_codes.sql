-- One row per accepted inbound message. Codes and subjects are sealed with
-- AES-GCM (DATA_KEY); only the sender domain and timestamps are plaintext.
CREATE TABLE codes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  payload_enc TEXT,
  subject_enc TEXT,
  CHECK (kind IN ('otp', 'forward_verify', 'other')),
  CHECK (kind <> 'other' OR payload_enc IS NULL)
);
CREATE INDEX codes_pending ON codes (kind, consumed_at, received_at);
CREATE INDEX codes_expiry ON codes (expires_at);
