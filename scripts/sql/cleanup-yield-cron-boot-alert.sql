-- One-shot cleanup for the dangling cron_state row from the
-- pre-2026-05-22 yield-cron boot-alert path. The boot-alert was
-- replaced by a daily heartbeat (cron_name = 'yield-distribution-heartbeat')
-- in the same commit; the legacy `yield-cron-boot-alert` row stays in
-- the table as inert data because drizzle declarative push doesn't run
-- data migrations.
--
-- Costs nothing in storage, but:
--   - The schema.ts docstring previously referenced it as load-bearing
--     (now corrected); future operators auditing `SELECT * FROM
--     cron_state` would see two yield-cron rows and have to read the
--     code to know which is live.
--   - Anyone monitoring cron_state freshness would see a row that
--     never advances post-2026-05-22.
--
-- Idempotent: re-running on a DB without the row deletes 0 rows
-- (no error). Safe to run multiple times.
--
-- Usage (prod):
--   ssh -i ~/.ssh/id_muhaven_vm muhaven@192.168.1.52 \
--     'docker compose -f /home/muhaven/Project/Fhenix/MuHaven/docker-compose.yml \
--        -p muhaven exec -T postgres psql -U muhaven -d muhaven' \
--     < scripts/sql/cleanup-yield-cron-boot-alert.sql
--
-- Filed by Backend-Architect M-2 + DevOps M-2 + Code-Reviewer M-2
-- (parallel review of the heartbeat-refactor commit, 2026-05-22).

DELETE FROM cron_state WHERE cron_name = 'yield-cron-boot-alert';

-- Verify the live cron_state rows post-cleanup:
SELECT cron_name, last_fired_at, NOW() - last_fired_at AS age
FROM cron_state
ORDER BY cron_name;
