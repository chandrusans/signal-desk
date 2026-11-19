import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calKey, quarterlyReports, estimateNext, calendarEntry, buildDates } from '../earnings-calendar.js';
import { signalFor } from '../strategies.js';

test('one key for every spelling of a share class', () => {
  assert.equal(calKey('brk-b'), 'BRK.B'); assert.equal(calKey('BRK/B'), 'BRK.B'); assert.equal(calKey(' kmi '), 'KMI');
});

test('a pre-announcement and the report three weeks later count as one quarter, dated by the report', () => {
  assert.deepEqual(quarterlyReports(['2026-01-08', '2026-01-28', '2026-04-29', '2026-04-29', '2026-07-29']), ['2026-01-28', '2026-04-29', '2026-07-29']);
});

test('the estimate keeps the company in last year\'s slot, on a weekday', () => {
  const past = ['2025-10-22', '2026-01-21', '2026-04-22', '2026-07-22', '2026-10-21'];
  const est = estimateNext(past, '2026-11-18');
  assert.equal(est, '2027-01-20', 'a year (52 weeks) after 2026-01-21');
  assert.ok(![0, 6].includes(new Date(est).getUTCDay()));
  assert.equal(estimateNext(['2026-07-22', '2026-10-21'], '2026-11-18'), '2027-01-20', 'no year-ago report: last + 91 days');
});

test('an overdue estimate is held at today; a company that stopped filing gets none', () => {
  const past = ['2025-11-10', '2026-02-10', '2026-05-12', '2026-08-11'];
  assert.equal(estimateNext(past, '2026-11-13'), '2026-11-13', 'due 2026-11-09, four days ago: any day now');
  assert.equal(estimateNext(['2025-01-10', '2025-04-10'], '2026-11-18'), null);
  assert.equal(estimateNext([], '2026-11-18'), null);
});

test('calendar rows beat estimates, the earliest date wins, and passed dates read as unknown', () => {
  const dates = buildDates([{ date: '2026-12-10', symbol: 'COST', when: 'post' }, { date: '2026-11-24', symbol: 'DELL', when: 'post' }, { date: '2026-12-01', symbol: 'DELL' }], { COST: '2027-03-01', KMI: '2027-01-20' });
  assert.deepEqual(dates.COST, ['2026-12-10', 'c', 'post']); assert.deepEqual(dates.DELL, ['2026-11-24', 'c', 'post']); assert.deepEqual(dates.KMI, ['2027-01-20', 'e', null]);
  const now = Date.parse('2026-11-19T15:00:00Z');
  const dell = calendarEntry({ dates }, 'DELL', now);
  assert.deepEqual({ date: dell.date, daysAway: dell.daysAway, estimated: dell.estimated, when: dell.when }, { date: '2026-11-24', daysAway: 5, estimated: false, when: 'post' });
  assert.equal(calendarEntry({ dates }, 'KMI', now).estimated, true);
  assert.equal(calendarEntry({ dates }, 'DELL', Date.parse('2026-11-25T15:00:00Z')), null, 'reported yesterday');
  assert.equal(calendarEntry({ dates }, 'DELL', Date.parse('2026-11-25T02:00:00Z')).daysAway, 0, '9 pm in New York on report day is still report day');
  assert.equal(calendarEntry({ dates }, 'ZZZZ', now), null); assert.equal(calendarEntry(null, 'KMI', now), null);
});

test('the earnings gate reads the calendar entry, and says when the date is an estimate', () => {
  const row = { t: 'KMI', p: 34.43, sc: 92, su: 'BREAKOUT', rs: 13, r20: 9, a50: true, a200: true, rsi2: 70, stop: 32.71, tgt: 38.73 };
  const rg = { level: 'calm', sizeMult: 1, allow: ['BREAKOUT', 'PULLBACK'] };
  const near = signalFor(row, { regime: rg, nextEarnings: { date: '2026-11-23', daysAway: 4, estimated: true }, today: '2026-11-19' });
  assert.equal(near.action, 'AVOID'); assert.match(near.reason, /expected in about 4 days \(around 2026-11-23, estimated from past reports\)/);
  const far = signalFor(row, { regime: rg, nextEarnings: { date: '2027-01-20', daysAway: 62, estimated: true }, today: '2026-11-19' });
  assert.equal(far.action, 'BUY'); assert.ok(!far.caveats.some((c) => /no next-earnings date/.test(c)), 'a dated name carries no "unknown" warning');
});
