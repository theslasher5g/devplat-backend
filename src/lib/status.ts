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

// --- Per-component daily uptime history (the OpenAI-style bars) ---

export interface DayStatus { date: string; status: StatusLevel }
export interface ComponentSummary { key: string; name: string; status: StatusLevel; uptime: number; history: DayStatus[] }

/** Map a post to the component-level status it implies on a day it's active. */
function postLevel(type: string, impact: string): StatusLevel {
  if (type === 'maintenance') return 'maintenance';
  if (type === 'announcement') return 'operational';
  if (impact === 'critical') return 'major_outage';
  if (impact === 'major') return 'partial_outage';
  if (impact === 'minor') return 'degraded';
  return 'operational';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the per-day status bar and uptime % for each component over a window,
 * derived from recorded incidents/maintenance — NOT continuous probing, so
 * this reflects what was actually posted on the status page. A day is colored
 * by the worst post affecting that component whose active interval
 * (created_at → resolved_at, or now if ongoing) overlaps the day. Uptime %
 * counts only real downtime (partial/major outages); maintenance and minor
 * degradation don't reduce it, matching how availability is normally reported.
 * The final (today) bar also folds in the component's current live status
 * (e.g. a host down right now with no incident posted yet).
 */
async function componentHistories(
  components: { key: string; status: StatusLevel }[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<string, { uptime: number; history: DayStatus[] }>> {
  const rows = await query<{
    type: string; impact: string; affected_components: string[]; created_at: string; resolved_at: string | null;
  }>(
    `SELECT type, impact, affected_components, created_at, resolved_at
     FROM status_posts
     WHERE type <> 'announcement'
       AND created_at < $2
       AND COALESCE(resolved_at, now()) > $1`,
    [windowStart.toISOString(), windowEnd.toISOString()],
  );

  const days = Math.round((windowEnd.getTime() - windowStart.getTime()) / DAY_MS);
  const nowMs = Date.now();
  const out = new Map<string, { uptime: number; history: DayStatus[] }>();

  for (const c of components) {
    const posts = rows.rows.filter((p) => p.affected_components.includes(c.key));
    const history: DayStatus[] = [];
    let downtimeMs = 0;

    for (let i = 0; i < days; i++) {
      const dayStart = windowStart.getTime() + i * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      let level: StatusLevel = 'operational';
      for (const p of posts) {
        const s = new Date(p.created_at).getTime();
        const e = p.resolved_at ? new Date(p.resolved_at).getTime() : nowMs;
        if (s < dayEnd && e > dayStart) {
          const lvl = postLevel(p.type, p.impact);
          if (RANK[lvl] > RANK[level]) level = lvl;
          // Accumulate downtime for outages (red), clamped to this day.
          if (lvl === 'partial_outage' || lvl === 'major_outage') {
            downtimeMs += Math.min(e, dayEnd) - Math.max(s, dayStart);
          }
        }
      }
      // Today's bar also reflects the live component status.
      const isToday = dayEnd > nowMs && dayStart <= nowMs;
      if (isToday && RANK[c.status] > RANK[level]) level = c.status;
      history.push({ date: new Date(dayStart).toISOString().slice(0, 10), status: level });
    }

    // Only count elapsed time (don't penalize the future part of today's window).
    const elapsedMs = Math.min(windowEnd.getTime(), nowMs) - windowStart.getTime();
    const uptime = elapsedMs > 0 ? Math.max(0, 1 - downtimeMs / elapsedMs) * 100 : 100;
    out.set(c.key, { uptime, history });
  }
  return out;
}

/** The public status page + dashboard panel both read this. `historyDays`>0
 *  includes the per-component daily bars + uptime; `before` ends the window
 *  earlier than now (for the status page's date-range paging). */
export async function getStatusSummary(opts: { historyDays?: number; before?: Date } = {}): Promise<{
  overall: { status: StatusLevel; label: string };
  components: ComponentSummary[];
  active: StatusPost[];
  upcoming: StatusPost[];
  recent: StatusPost[];
  window?: { start: string; end: string };
}> {
  const [componentRows, computeStatus] = await Promise.all([
    query<ComponentRow>('SELECT key, name, source, manual_status, position FROM status_components ORDER BY position, name'),
    deriveComputeStatus(),
  ]);
  const baseComponents = await Promise.all(
    componentRows.rows.map(async (c) => ({
      key: c.key, name: c.name, status: await effectiveComponentStatus(c, computeStatus),
    })),
  );

  // Optional history window (default: none, for the lightweight dashboard/footer reads).
  const historyDays = opts.historyDays && opts.historyDays > 0 ? Math.min(opts.historyDays, 365) : 0;
  let histories = new Map<string, { uptime: number; history: DayStatus[] }>();
  let window: { start: string; end: string } | undefined;
  if (historyDays > 0) {
    const end = opts.before ?? new Date();
    // Snap the window to whole UTC days ending at the end of the end-day.
    const windowEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) + DAY_MS);
    const windowStart = new Date(windowEnd.getTime() - historyDays * DAY_MS);
    histories = await componentHistories(baseComponents, windowStart, windowEnd);
    window = { start: windowStart.toISOString(), end: windowEnd.toISOString() };
  }
  const components: ComponentSummary[] = baseComponents.map((c) => ({
    ...c,
    uptime: histories.get(c.key)?.uptime ?? 100,
    history: histories.get(c.key)?.history ?? [],
  }));

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

  return { overall: { status, label: LABEL[status] }, components, active, upcoming, recent, window };
}
