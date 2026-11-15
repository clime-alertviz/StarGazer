import * as Astronomy from 'astronomy-engine';

export function skyAt(location, at, target) {
  const date = new Date(at);
  const observer = new Astronomy.Observer(location.lat, location.lon, 0);
  const position = body => {
    const equ = Astronomy.Equator(body, date, observer, true, true);
    const hor = Astronomy.Horizon(date, observer, equ.ra, equ.dec, 'normal');
    return { altitude: hor.altitude, azimuth: hor.azimuth };
  };
  const moon = position('Moon'), sun = position('Sun');
  const observed = target === 'stargazing' ? null : target === 'Moon' ? moon : position(target);
  return {
    at: date.toISOString(), sunAltitude: sun.altitude, sunAzimuth: sun.azimuth,
    moonAltitude: moon.altitude, moonAzimuth: moon.azimuth, moonIllumination: Astronomy.Illumination('Moon', date).phase_fraction,
    targetAltitude: observed?.altitude ?? null,
    targetAzimuth: observed?.azimuth ?? null,
  };
}

export function assessSky(location, start, end, target) {
  const samples = [];
  for (let t = start; t < end; t += 15 * 60000) samples.push(skyAt(location, t, target));
  samples.push(skyAt(location, end, target));
  const darknessLimit = target === 'stargazing' ? -18 : -12;
  return {
    suitable: samples.every(s => s.sunAltitude <= darknessLimit && (s.targetAltitude === null || s.targetAltitude >= 20)),
    minTargetAltitude: target === 'stargazing' ? null : Math.min(...samples.map(s => s.targetAltitude)),
    maxSunAltitude: Math.max(...samples.map(s => s.sunAltitude)),
    maxMoonAltitude: Math.max(...samples.map(s => s.moonAltitude)),
    moonIllumination: samples[0].moonIllumination,
    moonPenalty: target === 'stargazing' ? Math.max(...samples.map(s => s.moonAltitude > 0 ? s.moonIllumination : 0)) : 0,
    sampleMinutes: 15,
  };
}
