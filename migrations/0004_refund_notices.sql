-- Refund notices (Oct 20, 2026). One row per (order, email) once a "licence ended" email has been
-- claimed for sending, so Payhip webhook retries never send the same person a second email.
CREATE TABLE refund_notices (
  order_id   TEXT NOT NULL,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('buyer','member')),
  devices    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  PRIMARY KEY (order_id, email)
);
