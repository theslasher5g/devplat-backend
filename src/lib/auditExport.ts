/**
 * Query parsing and CSV formatting for the team audit log and its export
 * (GET /teams/me/audit, GET /teams/me/audit/export).
 *
 * Split out of the route so the parsing and escaping rules can be tested
 * directly — they are the parts where a mistake is silent: a filter that
 * quietly matches everything, or a cell that breaks out of its column and
 * corrupts a compliance export.
 */

export type AuditFilters = {
  from: string | null;
  to: string | null;
  action: string | null;
  actorLike: string | null;
  limit: number;
  offset: number;
};

/** Largest page the list endpoint will return, and the default page size. */
export const AUDIT_MAX_LIMIT = 200;
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_OFFSET = 100_000;

/** Parses the audit list/export query into safe, parameterised filter values.
 *  Everything is nullable so a single SQL statement handles every combination
 *  via `($n IS NULL OR ...)` rather than string-building a WHERE clause. */
export function auditFilters(q: Record<string, string | undefined>): AuditFilters {
  const date = (v: string | undefined): string | null => {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  // `min` matters: Number('') is 0, so a blank ?limit= would otherwise ask for
  // an empty page. A blank offset legitimately means 0, hence the parameter
  // rather than one shared floor.
  const num = (v: string | undefined, def: number, min: number, max: number): number => {
    if (v === undefined || v.trim() === '') return def;
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? Math.min(Math.trunc(n), max) : def;
  };
  const actor = q.actor?.trim();
  return {
    from: date(q.from),
    to: date(q.to),
    action: q.action?.trim() || null,
    // ILIKE with wrapped wildcards: an operator searching "@acme.com" should
    // match every address at that domain.
    actorLike: actor ? `%${actor}%` : null,
    limit: num(q.limit, AUDIT_DEFAULT_LIMIT, 1, AUDIT_MAX_LIMIT),
    offset: num(q.offset, 0, 0, AUDIT_MAX_OFFSET),
  };
}

/** ISO 8601 for export columns, whatever the driver handed us. */
export function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

/** RFC 4180 cell: quote when needed, and double any embedded quotes. */
export function csvCell(value: string): string {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header row of the CSV export, kept next to the row builder below. */
export const AUDIT_CSV_HEADER = 'timestamp,action,actor,target,detail\n';

/** One CSV line for a serialized audit entry. */
export function auditCsvRow(e: {
  createdAt: unknown; action: string; actorEmail?: string | null;
  target?: string | null; detail?: unknown;
}): string {
  return [
    // node-postgres hands back a Date for timestamptz; JSON.stringify would
    // render that as ISO but String() gives "Mon Jul 27 2026 …", which no
    // spreadsheet sorts correctly. Normalise explicitly.
    isoTimestamp(e.createdAt),
    e.action,
    e.actorEmail ?? '',
    e.target ?? '',
    JSON.stringify(e.detail ?? {}),
  ].map(csvCell).join(',');
}
