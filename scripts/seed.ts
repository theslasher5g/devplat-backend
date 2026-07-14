/**
 * Seed placeholder data-plane rows so the admin dashboard can be developed
 * against the real schema before the Firecracker scheduler exists.
 * Idempotent — safe to re-run.
 */
import { pool, query } from '../src/db.js';

async function main(): Promise<void> {
  await query(
    `INSERT INTO hosts (name, location, cpu_total, ram_total_mb, cpu_used, ram_used_mb, status, last_heartbeat)
     VALUES
       ('host-a', 'CH-ZRH-1', 32, 131072, 13, 54000, 'online', now()),
       ('host-b', 'CH-ZRH-1', 32, 131072, 0, 0, 'offline', NULL)
     ON CONFLICT (name) DO NOTHING`,
  );

  // A few usage events against the oldest team, if one exists.
  const team = await pool.query<{ id: string }>('SELECT id FROM teams ORDER BY created_at LIMIT 1');
  const host = await pool.query<{ id: string }>("SELECT id FROM hosts WHERE name = 'host-a'");
  if (team.rows[0] && host.rows[0]) {
    const existing = await pool.query('SELECT 1 FROM usage_events LIMIT 1');
    if (!existing.rowCount) {
      await query(
        `INSERT INTO usage_events (team_id, host_id, vm_id, event_type, occurred_at)
         VALUES
           ($1, $2, 'vm_seed01', 'start', now() - interval '3 hours'),
           ($1, $2, 'vm_seed01', 'stop', now() - interval '175 minutes'),
           ($1, $2, 'vm_seed02', 'start', now() - interval '2 hours'),
           ($1, $2, 'vm_seed02', 'stop', now() - interval '110 minutes'),
           ($1, $2, 'vm_seed03', 'start_failed', now() - interval '1 hour')`,
        [team.rows[0].id, host.rows[0].id],
      );
    }
  }
  console.log('seed complete');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
