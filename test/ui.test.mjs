import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, safeHref, money, px, parseNum, weekdaysBetween } from '../ui.js';

test('esc neutralises markup and attribute breakouts', () => {
  assert.equal(esc('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(esc("it's `ok`"), 'it&#39;s &#96;ok&#96;');
});
test('safeHref allows http(s) only', () => {
  assert.equal(safeHref('javascript:alert(1)'), '#');
  assert.equal(safeHref('data:text/html,x'), '#');
  assert.equal(safeHref('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&amp;c=2');
});
test('formatting is US-locale and handles sub-dollar coins', () => {
  assert.equal(money(1234.5), '$1,234.50'); assert.equal(money(-3), '−$3.00');
  assert.equal(px(0.0000095), '$0.00000950'); assert.equal(px(12.3456), '$12.35'); assert.equal(px(1234), '$1,234');
});
test('parseNum accepts comma decimals and thousands separators', () => {
  assert.equal(parseNum('1,5'), 1.5); assert.equal(parseNum('1,234.5'), 1234.5); assert.equal(parseNum('$12'), 12); assert.ok(Number.isNaN(parseNum('abc')));
});
test('weekdaysBetween counts sessions, not calendar days', () => {
  assert.equal(weekdaysBetween('2026-01-05', '2026-01-12'), 5);   // Mon → next Mon
  assert.equal(weekdaysBetween('2026-01-09', '2026-01-12'), 1);   // Fri → Mon
});
