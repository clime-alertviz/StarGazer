const minute = 60000;

export const localInput = date => {
  const d = new Date(date);
  return new Date(+d - d.getTimezoneOffset() * minute).toISOString().slice(0, 16);
};

export function observingWindow({ date, start, end }) {
  const from = new Date(`${date}T${start}`), until = new Date(`${date}T${end}`);
  if (until <= from) until.setDate(until.getDate() + 1);
  return { start: from, end: until };
}

export function quickDateWindow(date, preferences, now = Date.now()) {
  const selection = { date, start: preferences.start };
  const window = observingWindow({ ...preferences, date });
  if (+window.start > now || !Number.isFinite(+window.start)) return selection;

  // Leave time for the agent, then use a half-hour observing slot.
  const next = new Date(Math.ceil((now + 15 * minute) / (30 * minute)) * 30 * minute);
  if (+next + preferences.duration * minute <= +window.end) {
    const local = localInput(next);
    return { date: local.slice(0, 10), start: local.slice(11, 16) };
  }
  // Keep the chosen end time; do not silently turn an expired evening into tomorrow.
  return selection;
}

export function validateLiveWindow({ start, end }, duration, now = Date.now()) {
  if (!Number.isFinite(+start) || !Number.isFinite(+end)) throw new Error('Choose a date and valid start and end times.');
  if (+start <= now) throw new Error('Choose a future start time. If tonight’s window has passed, choose another night.');
  if (+end - +start < duration * minute) throw new Error('This window is too short. Choose a later end time or a shorter session.');
}
