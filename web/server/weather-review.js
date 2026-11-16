import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const windowKey = outing => hash([outing.start, outing.end, outing.site.location]);

export function weatherMessages(weather, timezone) {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return (weather?.failures || []).map(f =>
    `${f.label}: ${f.value}${f.unit === '%' || f.unit === '°C' ? '' : ' '}${f.unit} at ${format.format(new Date(f.at))} (${timezone}); planning ${f.bound === 'max' ? 'maximum' : 'minimum'} ${f.limit}${f.unit === '%' || f.unit === '°C' ? '' : ' '}${f.unit}.`);
}

// A decision applies to this place/time and the conditions actually reviewed.
// A newly failing metric or a worse value requires another organizer decision.
export function weatherAllowed(outing) {
  if (outing.weather?.suitable !== false) return true;
  const accepted = outing.weatherAcceptance;
  const failures = outing.weather.failures;
  return Boolean(accepted && accepted.window === windowKey(outing) && failures?.length &&
    !outing.weather.reason && failures.every(f => accepted.failures.some(previous =>
      previous.field === f.field && previous.bound === f.bound &&
      (f.bound === 'max' ? f.value <= previous.value : f.value >= previous.value))));
}

export function weatherReviewKey(outing, input, weather) {
  const { weatherConfirmation, ...request } = input;
  return hash([outing.id, outing.version, request, weather.failures]);
}

export function acceptWeather(outing, weather, userId) {
  return {
    window: windowKey(outing), failures: structuredClone(weather.failures),
    acceptedBy: userId, acceptedAt: new Date().toISOString(),
  };
}
