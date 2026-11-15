export function prepareInvitation(plan, { now = Date.now() } = {}) {
  if (plan.status !== 'proposal') throw new Error('Only an outing with confirmed night access can become an invitation.');
  if (plan.mode !== 'demo' && (Date.parse(plan.meetingStart) <= now || now - Date.parse(plan.createdAt) > 3600000)) throw new Error('This proposal is past or more than one hour old. Rerun planning first.');
  const emails = plan.participants.map(p => p.email);
  if (plan.mode !== 'demo' && emails.some(e => /@.*(?:example\.(?:com|org|net)|\.test|\.invalid)$/i.test(e))) throw new Error('Replace sample email addresses with real, consenting participants before inviting.');
  const local = at => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: plan.request.timezone }).format(new Date(at));
  const lines = [
    `Star Gazer plan: ${plan.planId}`,
    `Goal: ${plan.request.target === 'stargazing' ? 'Enjoy a dark-sky stargazing session' : `Observe ${plan.request.target}`}.`,
    `Meet: ${local(plan.meetingStart)} (${plan.request.timezone}).`,
    `Observe: ${local(plan.observingStart)} – ${local(plan.observingEnd)}.`,
    `Return to meeting point by ${local(plan.meetingEnd)}. Travel to/from the meeting point is outside this event.`,
    `Meeting point: ${plan.site.meetingPoint.lat}, ${plan.site.meetingPoint.lon}.`,
    `Observing spot: ${plan.site.location.lat}, ${plan.site.location.lon}; ${plan.site.walkMinutes} min walk each way.`,
    `Night access: ${plan.site.accessNote}`,
    `Allow ${plan.setupMinutes ?? 15} minutes to set up and ${plan.packUpMinutes ?? 0} minutes to pack up, included in the event.`,
    '', 'Equipment:', ...plan.equipment.map(e => `- ${e}`),
    ...(plan.carpools?.length ? ['', 'Proposed shared rides (confirm with driver and riders):', ...plan.carpools.flatMap(car => [
      `${car.driverName} drives ${car.pickups.map(p => p.name).join(', ')}; ${car.passengerSeats} passenger seats offered.`,
      ...car.pickups.map(p => `${p.name}: pickup ${local(p.pickupAt)} at ${p.pickup.name} (${p.pickup.location.lat}, ${p.pickup.location.lon}); return drop-off ${local(p.dropoffAt)} at the same point.`),
      `Driver pickup route (start from your own location): ${car.outboundNavigationUrl}`,
      `Return drop-offs (driver's final trip home omitted): ${car.returnNavigationUrl}`,
    ])] : []),
    ...(plan.traffic ? ['', `${plan.traffic.description} Driving buffer: ${plan.traffic.drivingBufferMinutes} min each way; pickup/drop-off dwell: ${plan.traffic.pickupStopMinutes} min per stop.`] : []),
    '', `Forecast retrieved ${plan.weather.fetchedAt}: cloud ≤${plan.weather.maxCloudCover}%, wind ≤${plan.weather.maxWindKmh} km/h, temperature ≥${plan.weather.minTemperatureC}°C.`,
    `Moon illuminated ${Math.round(plan.astronomy.moonIllumination * 100)}%; ${plan.astronomy.minTargetAltitude === null ? 'astronomical darkness checked' : `target altitude ≥${Math.floor(plan.astronomy.minTargetAltitude)}°`}.`,
    '', 'Navigation to the meeting point (choose your own origin):',
    ...[...new Map(plan.routes.map(r => [r.mode, r.navigationUrl])).entries()].map(([mode, url]) => `${mode}: ${url}`),
    '', 'Please RSVP in Google Calendar. Equipment and attendance remain subject to agreement.',
    ...plan.warnings,
    '', 'Location and journey calculations: https://www.geoapify.com/',
    'Weather: https://open-meteo.com/ (CC BY 4.0). Astronomy: Astronomy Engine (MIT).',
  ];
  return {
    planId: plan.planId,
    status: plan.mode === 'demo' ? 'demo_do_not_send' : 'ready_for_organizer',
    tool: 'google_calendar.create_event',
    arguments: {
      calendar_id: 'primary', title: `Star Gazer · ${plan.request.target} at ${plan.site.name}`,
      start_time: plan.meetingStart, end_time: plan.meetingEnd, timezone_str: plan.request.timezone,
      attendees: emails, location: `${plan.site.name} — meeting point ${plan.site.meetingPoint.lat}, ${plan.site.meetingPoint.lon}`,
      description: lines.join('\n'), notify: true, visibility: 'private', guests_can_modify: false, add_google_meet: false,
    },
    nextStep: plan.mode === 'demo'
      ? 'Inspect this payload only. Fixture participants must never receive a Calendar invitation.'
      : 'Show the organizer the time, place, attendees and equipment. Once sending is authorized, check Calendar conflicts and duplicates, then call the connected Calendar tool once with these arguments. Record its returned event ID and URL; if the result is ambiguous, search for the plan ID before retrying.',
  };
}
