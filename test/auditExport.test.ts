import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  auditCsvRow,
  auditFilters,
  csvCell,
  isoTimestamp,
} from '../src/lib/auditExport.js';

/**
 * The audit export is what a customer hands to an auditor, so a cell that
 * breaks out of its column is a correctness bug, not a cosmetic one. The
 * filter parsing matters for a different reason: every value here goes into a
 * parameterised query, and the guard against nonsense input is this function.
 */

test('an empty query means no filtering and a sane page size', () => {
  const f = auditFilters({});
  assert.deepEqual(f, {
    from: null, to: null, action: null, actorLike: null,
    limit: AUDIT_DEFAULT_LIMIT, offset: 0,
  });
});

test('dates are normalised to ISO 8601', () => {
  const f = auditFilters({ from: '2026-01-01', to: '2026-02-01T12:30:00Z' });
  assert.equal(f.from, new Date('2026-01-01').toISOString());
  assert.equal(f.to, new Date('2026-02-01T12:30:00Z').toISOString());
});

test('an unparseable date is dropped, not passed through', () => {
  // Handing "yesterday" to Postgres as a timestamptz would be a 500; treating
  // it as "no filter" shows the operator everything, which is the safe read.
  const f = auditFilters({ from: 'yesterday', to: '' });
  assert.equal(f.from, null);
  assert.equal(f.to, null);
});

test('the actor filter becomes a wrapped ILIKE pattern', () => {
  assert.equal(auditFilters({ actor: '  @acme.com ' }).actorLike, '%@acme.com%');
  assert.equal(auditFilters({ actor: '   ' }).actorLike, null, 'whitespace is not a filter');
});

test('a blank action is treated as no filter', () => {
  assert.equal(auditFilters({ action: ' token.created ' }).action, 'token.created');
  assert.equal(auditFilters({ action: '  ' }).action, null);
});

test('the page size is clamped, not trusted', () => {
  assert.equal(auditFilters({ limit: '10' }).limit, 10);
  assert.equal(auditFilters({ limit: '99999' }).limit, AUDIT_MAX_LIMIT);
  assert.equal(auditFilters({ limit: '25.9' }).limit, 25, 'fractions truncate');
  // A blank limit is the sharp edge: Number('') is 0, which would otherwise
  // read as "give me nothing" and return an empty page.
  for (const bad of ['-5', 'abc', '', '   ', '0', 'NaN', 'Infinity']) {
    assert.equal(auditFilters({ limit: bad }).limit, AUDIT_DEFAULT_LIMIT, `limit=${JSON.stringify(bad)}`);
  }
  assert.equal(auditFilters({ offset: '-1' }).offset, 0);
  assert.equal(auditFilters({ offset: '' }).offset, 0);
  assert.equal(auditFilters({ offset: '100' }).offset, 100);
});

test('plain cells are not quoted', () => {
  assert.equal(csvCell('token.created'), 'token.created');
  assert.equal(csvCell(''), '');
});

test('cells containing a separator, quote, or newline are quoted', () => {
  assert.equal(csvCell('Ops, EU'), '"Ops, EU"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell('line1\r\nline2'), '"line1\r\nline2"');
});

test('a detail blob full of commas and quotes survives as one cell', () => {
  const detail = JSON.stringify({ name: 'CI, prod', note: 'he said "no"' });
  const cell = csvCell(detail);
  assert.ok(cell.startsWith('"') && cell.endsWith('"'));
  // Un-escaping the RFC 4180 way must give back exactly what went in.
  assert.equal(cell.slice(1, -1).replace(/""/g, '"'), detail);
});

test('timestamps are ISO 8601 regardless of what the driver returned', () => {
  const iso = '2026-07-27T10:11:12.000Z';
  assert.equal(isoTimestamp(new Date(iso)), iso, 'node-postgres hands back a Date');
  assert.equal(isoTimestamp(iso), iso, 'a string round-trips');
  assert.equal(isoTimestamp('2026-07-27 10:11:12+00'), iso, 'Postgres text form');
  // Never "Mon Jul 27 2026 …" — no spreadsheet sorts that correctly.
  assert.ok(!isoTimestamp(new Date(iso)).includes('GMT'));
});

test('an unparseable timestamp degrades to its string form', () => {
  assert.equal(isoTimestamp('not a date'), 'not a date');
  assert.equal(isoTimestamp(null), 'null');
});

test('a row has exactly five columns even when fields are missing', () => {
  const row = auditCsvRow({
    createdAt: new Date('2026-07-27T10:11:12.000Z'),
    action: 'member.removed',
    actorEmail: null,
    target: null,
    detail: null,
  });
  assert.equal(row, '2026-07-27T10:11:12.000Z,member.removed,,,{}');
});

test('a row with commas everywhere still parses as five columns', () => {
  const row = auditCsvRow({
    createdAt: '2026-07-27T10:11:12.000Z',
    action: 'team.renamed',
    actorEmail: 'ops@acme.com',
    target: 'Acme, Inc.',
    detail: { from: 'A, B', to: 'C' },
  });
  assert.equal(splitCsvLine(row).length, 5);
  assert.equal(splitCsvLine(row)[3], 'Acme, Inc.');
});

/** Minimal RFC 4180 line splitter, used to prove the escaping round-trips. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = false; }
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}
