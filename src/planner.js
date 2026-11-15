import { randomUUID } from 'node:crypto';
import { planInput } from './schema.js';
import { assessSky } from './astronomy.js';
import { assessWeather, fetchForecast } from './weather.js';
import { createTransport, journeyFits, describeTransport } from './transport.js';

const minute = 60000;
import { setupMinutes, packUpMinutes } from './timing.js';
const weights = { best_sky: 0.85, shortest_journey: 0.15, balanced: 0.5 };
const covered = (windows, start, end) => windows.some(w => Date.parse(w.start) <= start && Date.parse(w.end) >= end);
const subsets = list => Array.from({ length: 2 ** list.length }, (_, mask) => list.filter((_, i) => mask & (1 << i)));

const travelCost = (option, group, site) => group.reduce((sum, p) => sum + (1 - weights[p.preference]) *
  (Math.max(option.journeys[p.id].outbound.minutes, option.journeys[p.id].return.minutes) + site.walkMinutes) / p.maxTravelMinutes, 0) / group.length;
const utility = (skyQuality, option, group, site) => group.reduce((sum, p) => sum + weights[p.preference] * skyQuality + 1 - weights[p.preference], 0) / group.length - travelCost(option, group, site);

function equipmentFor(group, target) {
  if (target === 'stargazing' || target === 'Moon') return { suitable: true, arrangements: ['Bring warm layers and a dim red light. Binoculars are optional.'] };
  const owners = group.filter(p => p.equipment.includes('telescope'));
  const sharing = owners.find(p => p.shareEquipment);
  if (sharing) return { suitable: true, arrangements: [`${sharing.name} offers a shared telescope; confirm transport and setup with them.`] };
  if (owners.length === group.length) return { suitable: true, arrangements: ['Each participant brings their own telescope.'] };
  return { suitable: false, arrangements: [] };
}

export async function planOuting(input, { geo, forecast = fetchForecast, now = Date.now(), demo = false, sky = assessSky } = {}) {
  const wallStartedAt = Date.now();
  const { request, participants, sites } = planInput.parse(input);
  const searchStart = Date.parse(request.start), searchEnd = Date.parse(request.end);
  if (!demo && (searchStart < now || searchEnd > now + 15 * 86400000)) throw new Error('Choose a future window ending within the next 15 days; forecast coverage is checked separately.');
  const exclusions = {};
  const reject = key => { exclusions[key] = (exclusions[key] ?? 0) + 1; };
  const candidates = [];
  const eligible = participants.filter(p => p.interests.includes(request.target) || p.interests.includes('stargazing'));
  if (!eligible.some(p => p.id === request.organizerId)) return { status: 'no_match', reason: 'The organizer has no matching interest.', exclusions };
  const groups = subsets(eligible).filter(g => g.length >= request.minPeople && g.length <= request.maxPeople &&
    g.some(p => p.id === request.organizerId) && g.every(p => g.length >= p.groupSize.min && g.length <= p.groupSize.max));
  const compatible = groups.map(group => ({ group, equipment: equipmentFor(group, request.target) })).filter(({ group, equipment }) => {
    if (!equipment.suitable) { reject('no_shared_telescope'); return false; }
    if (request.needsGuide && !group.some(p => p.experience === 'experienced' && p.happyToTeach)) { reject('no_guide'); return false; }
    return true;
  });
  if (!compatible.length) return { status: 'no_match', reason: 'No group meets interests, group size, equipment and teaching requirements.', exclusions };

  const usableSites = sites.filter(s => s.access !== 'closed');
  if (!usableSites.length) return { status: 'no_match', reason: 'All sites are closed.', exclusions: { closed_sites: sites.length } };
  const transport = await createTransport(eligible, usableSites, request, geo);

  for (const site of usableSites) {
    const groupsWithTransport = compatible.map(c => ({ ...c, choices: transport.options(c.group, site).sort((a, b) =>
      a.pickupPreferenceMisses - b.pickupPreferenceMisses || travelCost(a, c.group, site) - travelCost(b, c.group, site)) }));
    if (groupsWithTransport.every(g => !g.choices.length)) { reject('no_feasible_transport'); continue; }
    const weather = await forecast(site.location);
    const fetchedAt = Date.parse(weather.fetchedAt);
    const checkedAt = now + (Date.now() - wallStartedAt);
    if (!demo && (!Number.isFinite(fetchedAt) || fetchedAt > checkedAt + minute || checkedAt - fetchedAt > 3600000)) throw new Error('Forecast is stale or has no valid retrieval time. Fetch it again.');
    for (let start = Math.ceil(searchStart / (30 * minute)) * 30 * minute; start + request.durationMinutes * minute <= searchEnd; start += 30 * minute) {
      const end = start + request.durationMinutes * minute;
      if (!covered(site.accessWindows, start - (setupMinutes + site.walkMinutes) * minute, end + (packUpMinutes + site.walkMinutes) * minute)) { reject('outside_site_access_hours'); continue; }
      const astronomy = sky(site.location, start, end, request.target);
      if (!astronomy.suitable) { reject('not_dark_or_target_too_low'); continue; }
      const conditions = assessWeather(weather, start, end, request);
      if (!conditions.suitable) { reject(conditions.reason ?? 'poor_weather'); continue; }
      for (const { group, equipment, choices } of groupsWithTransport) {
        const travelOptions = choices.filter(option => group.every(p => journeyFits(p, option.journeys[p.id], site, start, end)));
        if (!travelOptions.length) { reject('travel_or_availability'); continue; }
        const darkness = site.bortle === null ? 0.5 : 1 - (site.bortle - 1) / 8;
        const skyQuality = request.target === 'stargazing'
          ? 0.6 * (1 - conditions.maxCloudCover / 100) + 0.2 * darkness + 0.2 * (1 - astronomy.moonPenalty)
          : 0.8 * (1 - conditions.maxCloudCover / 100) + 0.2 * astronomy.minTargetAltitude / 90;
        const score = utility(skyQuality, travelOptions[0], group, site);
        candidates.push({ start, end, site, group, equipment: equipment.arrangements, astronomy, weather: conditions, skyQuality, score, travelOptions });
      }
    }
  }
  candidates.sort((a, b) => Number(b.site.access === 'confirmed') - Number(a.site.access === 'confirmed') || b.score - a.score || b.group.length - a.group.length || a.start - b.start || a.site.id.localeCompare(b.site.id));
  if (!candidates.length) return { status: 'no_match', reason: 'No outing satisfies the constraints. Review exclusions before changing a preference.', exclusions };

  // Validate whole pickup itineraries, walking legs and the reverse return route.
  // If the first assignment fails, try the next order/driver before excluding it.
  let selected, selectedTransport;
  for (const candidate of candidates) {
    for (const option of candidate.travelOptions) {
      const detailed = await transport.validate(option, candidate.group, candidate.site);
      if (detailed && candidate.group.every(p => journeyFits(p, detailed.journeys[p.id], candidate.site, candidate.start, candidate.end))) {
        selected = { ...candidate, score: utility(candidate.skyQuality, detailed, candidate.group, candidate.site) };
        selectedTransport = describeTransport(detailed, candidate.group, candidate.site, candidate.start, candidate.end);
        break;
      }
      reject('detailed_route_conflict');
    }
    if (selected) break;
  }
  if (!selected) return { status: 'no_match', reason: 'Detailed routes do not fit travel limits or availability.', exclusions };
  const s = selected;
  return {
    status: s.site.access === 'confirmed' ? 'proposal' : 'needs_access_check',
    planId: randomUUID(), mode: demo ? 'demo' : 'live', createdAt: new Date(now).toISOString(),
    request, observingStart: new Date(s.start).toISOString(), observingEnd: new Date(s.end).toISOString(),
    meetingStart: new Date(s.start - (setupMinutes + s.site.walkMinutes) * minute).toISOString(),
    meetingEnd: new Date(s.end + (packUpMinutes + s.site.walkMinutes) * minute).toISOString(),
    setupMinutes, packUpMinutes, site: s.site, participants: s.group, ...selectedTransport, equipment: s.equipment,
    traffic: { model: request.trafficModel, drivingBufferMinutes: request.drivingBufferMinutes, pickupStopMinutes: request.pickupStopMinutes, liveTraffic: false, departureTimePrediction: false,
      description: request.trafficModel === 'approximated' ? 'Geoapify approximated traffic adjusts road speeds for likely congestion. It is not live traffic or a departure-time forecast.' : 'Free-flow driving estimates assume uncongested roads.' },
    astronomy: s.astronomy, weather: s.weather, score: Number(s.score.toFixed(4)),
    scoring: 'Mean participant utility: sky weight best_sky=0.85, balanced=0.5, shortest_journey=0.15; remaining weight is travel. Confirmed access ranks first. Score is a heuristic, not a probability.',
    alternatives: candidates.filter(c => c.site.id !== s.site.id || c.start !== s.start).slice(0, 3).map(c => ({ site: c.site.name, observingStart: new Date(c.start).toISOString(), participants: c.group.map(p => p.id), score: Number(c.score.toFixed(4)), detailedRoutesChecked: false })),
    exclusions,
    warnings: [
      ...(demo ? ['DEMO: fictional profiles, site access, weather and journeys. Astronomy is calculated for the recorded date. Do not send invitations.'] : []),
      ...(s.site.access !== 'confirmed' ? ['Night access needs confirmation before an invitation can be prepared.'] : []),
      ...(s.site.bortle === null ? ['Light pollution is unknown; no dark-sky claim has been made.'] : []),
      'Forecasts are provisional. Recheck conditions before departure.',
      'Target altitude assumes a level horizon; trees, terrain and atmospheric seeing are not modelled.',
      `Driving uses ${request.trafficModel} traffic plus ${request.drivingBufferMinutes} minutes of buffer each way. No live traffic or departure-time prediction. Navigation links may select a different route.`,
      ...(selectedTransport.carpools.length ? ['Carpool offers and public pickup points must be confirmed by drivers and riders. Return drop-offs reverse the pickup order. Passenger seats must already allow for equipment.'] : []),
      'Availability comes from profiles. RSVP and equipment-sharing acceptance are still pending.',
    ],
    sources: ['https://www.geoapify.com/', 'https://open-meteo.com/', 'https://github.com/cosinekitty/astronomy'],
  };
}
