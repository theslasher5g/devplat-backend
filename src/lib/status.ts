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
  group_name: string | null;
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

/**
 * Append a transition to status_component_events for every derived/manual
 * component whose effective status changed since its last recorded event.
 * Called by the health poller each tick, so both auto-detected compute
 * outages and admin manual overrides land in the history within one poll
 * interval — without any per-poll snapshot noise (a row is written only on an
 * actual change). Incidents are NOT recorded here; they already live in
 * status_posts and are unioned in by componentHistories.
 *
 * The 'api' component is deliberately never logged: effectiveComponentStatus
 * reports it operational whenever this code runs (if the API were down,
 * nothing here would execute to record it), so an API outage is an admin
 * incident post, not an auto-event.
 */
export async function recordComponentStatuses(): Promise<void> {
  const [componentRows, computeStatus] = await Promise.all([
    query<ComponentRow>('SELECT key, name, source, manual_status, position, group_name FROM status_components'),
    deriveComputeStatus(),
  ]);
  for (const c of componentRows.rows) {
    const status = await effectiveComponentStatus(c, computeStatus);
    const last = await query<{ status: StatusLevel }>(
      'SELECT status FROM status_component_events WHERE component_key = $1 ORDER BY changed_at DESC LIMIT 1',
      [c.key],
    );
    const prev = last.rows[0]?.status;
    // First-ever sight of a component: only start the log once it's actually
    // impaired. Logging a baseline "operational since the beginning of time"
    // adds nothing (absence of events already means operational).
    if (prev === undefined) {
      if (status !== 'operational') {
        await query('INSERT INTO status_component_events (component_key, status) VALUES ($1, $2)', [c.key, status]);
      }
    } else if (prev !== status) {
      await query('INSERT INTO status_component_events (component_key, status) VALUES ($1, $2)', [c.key, status]);
    }
  }
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
export interface ComponentSummary {
  key: string; name: string; status: StatusLevel; uptime: number; history: DayStatus[];
  // Present on group nodes: the member components, each a full summary.
  children?: ComponentSummary[];
}

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
// A span of impaired time for one component, from either source (an incident
// post or an auto/manual status event). Half-open [start, end).
interface Impairment { keys: Set<string>; start: number; end: number; level: StatusLevel }

/** Sum the length of the union of the given intervals (already filtered to the
 *  ones that count as downtime), so overlapping spans from different sources —
 *  e.g. an auto-detected outage that was ALSO posted as an incident — are
 *  counted once, not twice. */
function unionLength(intervals: { start: number; end: number }[]): number {
  const spans = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const { start, end } of spans) {
    if (start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

async function componentHistories(
  // Each entry matches impairments affecting ANY of its keys (a single
  // component has one key; a group has all its members' keys, so it's impaired
  // whenever any member is). `status` is the entry's current live status,
  // folded into today.
  entries: { id: string; keys: string[]; status: StatusLevel }[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<string, { uptime: number; history: DayStatus[] }>> {
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();
  const nowMs = Date.now();

  // Source 1 — admin-posted incidents/maintenance overlapping the window.
  const postRows = await query<{
    type: string; impact: string; affected_components: string[]; created_at: string; resolved_at: string | null;
  }>(
    `SELECT type, impact, affected_components, created_at, resolved_at
     FROM status_posts
     WHERE type <> 'announcement'
       AND created_at < $2
       AND COALESCE(resolved_at, now()) > $1`,
    [windowStart.toISOString(), windowEnd.toISOString()],
  );

  // Source 2 — the auto/manual status transition log. Fetch every event up to
  // the window end (transitions are sparse), ordered per component, so each
  // component's status timeline can be reconstructed including the event that
  // was already in effect when the window opened.
  const eventRows = await query<{ component_key: string; status: StatusLevel; changed_at: string }>(
    `SELECT component_key, status, changed_at
     FROM status_component_events
     WHERE changed_at < $1
     ORDER BY component_key, changed_at`,
    [windowEnd.toISOString()],
  );

  // Build the flat list of impairments (non-operational spans), clamped to the
  // window, from both sources.
  const impairments: Impairment[] = [];
  for (const p of postRows.rows) {
    const lvl = postLevel(p.type, p.impact);
    if (lvl === 'operational') continue;
    const s = Math.max(startMs, new Date(p.created_at).getTime());
    const e = Math.min(endMs, p.resolved_at ? new Date(p.resolved_at).getTime() : nowMs);
    if (e > s) impairments.push({ keys: new Set(p.affected_components), start: s, end: e, level: lvl });
  }
  // Turn the per-component event stream into spans: each event runs until the
  // next event for the same component (or now, if it's the latest).
  const byKey = new Map<string, { status: StatusLevel; at: number }[]>();
  for (const ev of eventRows.rows) {
    const list = byKey.get(ev.component_key) ?? [];
    list.push({ status: ev.status, at: new Date(ev.changed_at).getTime() });
    byKey.set(ev.component_key, list);
  }
  for (const [key, evs] of byKey) {
    for (let i = 0; i < evs.length; i++) {
      if (evs[i].status === 'operational') continue; // a recovery ends a span, doesn't start one
      const spanStart = Math.max(startMs, evs[i].at);
      const spanEnd = Math.min(endMs, i + 1 < evs.length ? evs[i + 1].at : nowMs);
      if (spanEnd > spanStart) {
        impairments.push({ keys: new Set([key]), start: spanStart, end: spanEnd, level: evs[i].status });
      }
    }
  }

  const days = Math.round((endMs - startMs) / DAY_MS);
  const out = new Map<string, { uptime: number; history: DayStatus[] }>();

  for (const entry of entries) {
    const keySet = new Set(entry.keys);
    const mine = impairments.filter((im) => [...im.keys].some((k) => keySet.has(k)));
    const history: DayStatus[] = [];

    for (let i = 0; i < days; i++) {
      const dayStart = startMs + i * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      let level: StatusLevel = 'operational';
      for (const im of mine) {
        if (im.start < dayEnd && im.end > dayStart && RANK[im.level] > RANK[level]) level = im.level;
      }
      // Today's bar also reflects the live status (e.g. a host down right now
      // whose transition hasn't been recorded by the poller yet).
      const isToday = dayEnd > nowMs && dayStart <= nowMs;
      if (isToday && RANK[entry.status] > RANK[level]) level = entry.status;
      history.push({ date: new Date(dayStart).toISOString().slice(0, 10), status: level });
    }

    // Uptime counts only real downtime (partial/major outages), unioned across
    // sources so a doubly-recorded outage isn't penalised twice. Maintenance
    // and minor degradation don't reduce it, matching standard reporting.
    const downtimeMs = unionLength(mine.filter((im) => im.level === 'partial_outage' || im.level === 'major_outage'));
    const elapsedMs = Math.min(endMs, nowMs) - startMs;
    const uptime = elapsedMs > 0 ? Math.max(0, 1 - downtimeMs / elapsedMs) * 100 : 100;
    out.set(entry.id, { uptime, history });
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
  const [componentRows, computeStatus, activeRowsEarly] = await Promise.all([
    query<ComponentRow>('SELECT key, name, source, manual_status, position, group_name FROM status_components ORDER BY position, name'),
    deriveComputeStatus(),
    query<PostRow>(
      `SELECT * FROM status_posts
       WHERE resolved_at IS NULL AND NOT (type = 'maintenance' AND state = 'scheduled')
       ORDER BY created_at DESC`,
    ),
  ]);

  // Worst active-incident/maintenance impact per component, so a component's
  // current icon reflects an ongoing incident affecting it (not just its bar).
  const activeImpact = new Map<string, StatusLevel>();
  for (const p of activeRowsEarly.rows) {
    if (p.type === 'announcement') continue;
    const lvl = postLevel(p.type, p.impact);
    for (const key of p.affected_components) {
      if (RANK[lvl] > RANK[activeImpact.get(key) ?? 'operational']) activeImpact.set(key, lvl);
    }
  }

  // Flat list of leaf components with their live status — the worse of the
  // derived/manual status and any active incident affecting them — preserving
  // DB order and group membership.
  const leaves = await Promise.all(
    componentRows.rows.map(async (c) => ({
      key: c.key, name: c.name, group: c.group_name,
      status: worst([await effectiveComponentStatus(c, computeStatus), activeImpact.get(c.key) ?? 'operational']),
    })),
  );

  // Assemble the display order: the first time a group is seen, emit the whole
  // group (with its members as children); ungrouped components emit inline.
  type Node = { key: string; name: string; status: StatusLevel; children?: typeof leaves };
  const displayNodes: Node[] = [];
  const seenGroups = new Set<string>();
  for (const l of leaves) {
    if (!l.group) {
      displayNodes.push({ key: l.key, name: l.name, status: l.status });
      continue;
    }
    if (seenGroups.has(l.group)) continue;
    seenGroups.add(l.group);
    const members = leaves.filter((m) => m.group === l.group);
    displayNodes.push({
      key: `group:${l.group}`, name: l.group,
      status: worst(members.map((m) => m.status)),
      children: members,
    });
  }

  // Optional history window (default: none, for the lightweight dashboard/footer reads).
  const historyDays = opts.historyDays && opts.historyDays > 0 ? Math.min(opts.historyDays, 365) : 0;
  let histories = new Map<string, { uptime: number; history: DayStatus[] }>();
  let window: { start: string; end: string } | undefined;
  if (historyDays > 0) {
    const end = opts.before ?? new Date();
    // Snap the window to whole UTC days ending at the end of the end-day.
    const windowEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) + DAY_MS);
    const windowStart = new Date(windowEnd.getTime() - historyDays * DAY_MS);
    // One history entry per leaf (its own key) and per group (union of member
    // keys, so the group's bar is red whenever any member is).
    const entries = [
      ...leaves.map((l) => ({ id: `leaf:${l.key}`, keys: [l.key], status: l.status })),
      ...displayNodes.filter((n) => n.children).map((n) => ({
        id: n.key, keys: n.children!.map((m) => m.key), status: n.status,
      })),
    ];
    histories = await componentHistories(entries, windowStart, windowEnd);
    window = { start: windowStart.toISOString(), end: windowEnd.toISOString() };
  }
  const withHistory = (id: string, base: { key: string; name: string; status: StatusLevel }): ComponentSummary => ({
    ...base,
    uptime: histories.get(id)?.uptime ?? 100,
    history: histories.get(id)?.history ?? [],
  });
  const components: ComponentSummary[] = displayNodes.map((n) =>
    n.children
      ? { ...withHistory(n.key, n), children: n.children.map((m) => withHistory(`leaf:${m.key}`, m)) }
      : withHistory(`leaf:${n.key}`, n),
  );
  // Overall is computed from the leaf statuses (below), unaffected by grouping.
  const baseComponents = leaves;

  // Active reuses the rows fetched up top. Upcoming = scheduled maintenance
  // still in the future. Recent = the last handful of resolved posts.
  const [upcomingRows, recentRows] = await Promise.all([
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
    attachUpdates(activeRowsEarly.rows), attachUpdates(upcomingRows.rows), attachUpdates(recentRows.rows),
  ]);

  // Overall = worst of component statuses plus what active posts imply.
  const postLevels: StatusLevel[] = active.map((p) => postLevel(p.type, p.impact));
  const status = worst([...baseComponents.map((c) => c.status), ...postLevels]);

  return { overall: { status, label: LABEL[status] }, components, active, upcoming, recent, window };
}
