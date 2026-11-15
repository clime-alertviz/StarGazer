import test from 'node:test';
import assert from 'node:assert/strict';
import { observingWindow, quickDateWindow, validateLiveWindow } from '../web/public/planning-time.js';

const evening = { date: '2026-11-15', start: '18:00', end: '23:30', duration: 60 };
const at = time => +new Date(`2026-11-15T${time}`);

test('Tonight moves an elapsed start into a future slot while retaining the end time', () => {
  const now = at('19:00');
  const selected = { ...evening, ...quickDateWindow(evening.date, evening, now) };
  const window = observingWindow(selected);
  assert.ok(+window.start >= now + 15 * 60000);
  assert.equal(+window.end, at('23:30'));
  assert.doesNotThrow(() => validateLiveWindow(window, selected.duration, now));
});

test('Quick dates preserve a future start, including a custom time and tomorrow', () => {
  const custom = { ...evening, start: '21:15' };
  assert.deepEqual(quickDateWindow(evening.date, custom, at('19:00')), { date: evening.date, start: '21:15' });
  assert.deepEqual(quickDateWindow('2026-11-16', evening, at('19:00')), { date: '2026-11-16', start: '18:00' });
});

test('An expired evening is rejected without silently extending its end or changing its date', () => {
  for (const now of [at('23:00'), at('23:50')]) {
    const selected = { ...evening, ...quickDateWindow(evening.date, evening, now) };
    assert.deepEqual(selected, evening);
    assert.equal(+observingWindow(selected).end, at('23:30'));
    assert.throws(() => validateLiveWindow(observingWindow(selected), selected.duration, now), /future start/);
  }
});

test('Tonight can move past midnight when the user already chose an overnight window', () => {
  const overnight = { ...evening, end: '02:00' }, now = at('23:50');
  const selected = { ...overnight, ...quickDateWindow(overnight.date, overnight, now) };
  const window = observingWindow(selected);
  assert.equal(selected.date, '2026-11-16');
  assert.ok(+window.start >= now + 15 * 60000);
  assert.equal(+window.end, +new Date('2026-11-16T02:00'));
  assert.doesNotThrow(() => validateLiveWindow(window, selected.duration, now));
});

test('Validation catches times that elapsed while the form was open, invalid input and short windows', () => {
  const now = at('19:00');
  assert.throws(() => validateLiveWindow(observingWindow(evening), 60, now), /future start/);
  assert.throws(() => validateLiveWindow(observingWindow({ ...evening, start: '' }), 60, now), /valid start and end/);
  assert.throws(() => validateLiveWindow(observingWindow({ ...evening, start: '23:00' }), 60, now), /too short/);
});
