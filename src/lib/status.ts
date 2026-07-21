import { query } from '../db.js';

// Component/overall status levels, ordered worst-last so a numeric rank can
// pick "the worst thing currently true".
export type StatusLevel = 'operational' | 'maintenance' | 'degraded' | 'partial_outage' | 'major_outage';

const RANK: Record<StatusLevel, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
};

const LABEL: Record<StatusLevel, string> = {
  operational: 'All systems operational',
  maintenance: 'Under maintenance',
  degraded: 'Degraded performance',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
};

function worst(levels: StatusLevel[]): StatusLevel {
  return levels.reduce<StatusLevel>((acc, l) => (RANK[l] > RANK[acc] ? l : acc), 'operational');
}

interface ComponentRow {
  key: string; name: string; source: 'api' | 'compute' | 'manual'; manual_status: StatusLevel | null; position: number;
}

/** Aggregate the compute component from live host rows: all online → up, some
 *  down → degraded, none up → major outage. Zero registered hosts is treated
 *  as operational (a fresh/dev deploy shouldn't cry wolf); the admin can pin
 *  an override if that's ever wrong. */
async function deriveComputeStatus(): Promise<StatusLevel> {
  const rows = await query<{ status: string }>('SELECT status FROM hosts');
  if (rows.rows.length === 0) return 'operational';
  const online = rows.rows.filter((h) => h.status === 'online' || h.status === 'draining').length;
  if (online === 0) return 'major_outage';
  if (online < rows.rows.length) return 'degraded';
  return 'operational';
}

async function effectiveComponentStatus(c: ComponentRow, computeStatus: StatusLevel): Promise<StatusLevel> {
  if (c.manual_status) return c.manual_status; // admin override / manual value
  if (c.source === 'compute') return computeStatus;
  return 'operational'; // 'api': if this code runs, the API is up
}

export interface StatusPost {
  id: string; type: 'incident' | 'maintenance' | 'announcement'; title: string; body: string;
  impact: string; state: string; affectedComponents: string[];
  scheduledStart: string | null; scheduledEnd: string | null;
  createdAt: string; updatedAt: string; resolvedAt: string | null;
  updates: { id: string; state: string | null; body: string; createdAt: string }[];
}

export interface PostRow {
  id: string; type: StatusPost['type']; title: string; body: string; impact: string; state: string;
  affected_components: string[]; scheduled_start: string | null; scheduled_end: string | null;
  created_at: string; updated_at: string; resolved_at: string | null;
}

export async function attachUpdates(posts: PostRow[]): Promise<StatusPost[]> {
  if (posts.length === 0) return [];
  const ids = posts.map((p) => p.id);
  const updates = await query<{ id: string; post_id: string; state: string | null; body: string; created_at: string }>(
    'SELECT id, post_id, state, body, created_at FROM status_post_updates WHERE post_id = ANY($1) ORDER BY created_at',
    [ids],
  );
  const byPost = new Map<string, StatusPost['updates']>();
  for (const u of updates.rows) {
    const list = byPost.get(u.post_id) ?? [];
    list.push({ id: u.id, state: u.state, body: u.body, createdAt: u.created_at });
    byPost.set(u.post_id, list);
  }
  return posts.map((p) => ({
    id: p.id, type: p.type, title: p.title, body: p.body, impact: p.impact, state: p.state,
    affectedComponents: p.affected_components, scheduledStart: p.scheduled_start, scheduledEnd: p.scheduled_end,
    createdAt: p.created_at, updatedAt: p.updated_at, resolvedAt: p.resolved_at,
    updates: byPost.get(p.id) ?? [],
  }));
}

/** The public status page + dashboard panel both read this. */
export async function getStatusSummary(): Promise<{
  overall: { status: StatusLevel; label: string };
  components: { key: string; name: string; status: StatusLevel }[];
  active: StatusPost[];
  upcoming: StatusPost[];
  recent: StatusPost[];
}> {
  const [componentRows, computeStatus] = await Promise.all([
    query<ComponentRow>('SELECT key, name, source, manual_status, position FROM status_components ORDER BY position, name'),
    deriveComputeStatus(),
  ]);
  const components = await Promise.all(
    componentRows.rows.map(async (c) => ({
      key: c.key, name: c.name, status: await effectiveComponentStatus(c, computeStatus),
    })),
  );

  // Active = unresolved incidents + in-progress maintenance + published
  // announcements. Upcoming = scheduled maintenance still in the future.
  // Recent = the last handful of resolved/completed posts for the history.
  const [activeRows, upcomingRows, recentRows] = await Promise.all([
    query<PostRow>(
      `SELECT * FROM status_posts
       WHERE resolved_at IS NULL AND NOT (type = 'maintenance' AND state = 'scheduled')
       ORDER BY created_at DESC`,
    ),
    query<PostRow>(
      `SELECT * FROM status_posts
       WHERE type = 'maintenance' AND state = 'scheduled' AND resolved_at IS NULL
       ORDER BY scheduled_start NULLS LAST, created_at DESC`,
    ),
    query<PostRow>(
      `SELECT * FROM status_posts WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 10`,
    ),
  ]);

  const [active, upcoming, recent] = await Promise.all([
    attachUpdates(activeRows.rows), attachUpdates(upcomingRows.rows), attachUpdates(recentRows.rows),
  ]);

  // Overall = worst of component statuses plus what active posts imply.
  const postLevels: StatusLevel[] = active.map((p) => {
    if (p.type === 'maintenance') return 'maintenance';
    if (p.type === 'announcement') return 'operational';
    if (p.impact === 'critical') return 'major_outage';
    if (p.impact === 'major') return 'partial_outage';
    if (p.impact === 'minor') return 'degraded';
    return 'operational';
  });
  const status = worst([...components.map((c) => c.status), ...postLevels]);

  return { overall: { status, label: LABEL[status] }, components, active, upcoming, recent };
}
