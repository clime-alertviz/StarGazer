---
id: your-id
name: Your name
email: replace-me@example.test
origin: { lat: 50.0755, lon: 14.4378 }
timezone: Europe/Prague
interests: [Saturn, stargazing]
experience: beginner
happyToTeach: false
equipment: []
shareEquipment: false
transport: drive
car:
  available: true
  offerRides: false
  passengerSeats: 0
  maxDetourMinutes: 15
  pickupPoints: [] # Optional: up to three named public points.
maxTravelMinutes: 60
maxWalkMinutes: 15
groupSize: { min: 2, max: 4 }
preference: balanced
availability:
  - { start: '2026-11-20T17:00:00+01:00', end: '2026-11-20T23:30:00+01:00' }
---
Copy this into a private directory and replace the identity, coordinates and dates.
Use a nearby public starting point if you do not want to share your home location.
Availability includes the whole trip, with setup and travel home.

Supported values:
- interests: Saturn, Jupiter, Mars, Moon, stargazing
- experience: beginner, experienced
- equipment: telescope, binoculars, camera, tripod
- transport: drive, bicycle, walk, ride
- preference: best_sky, shortest_journey, balanced

The travel limit is per direction, including walking, pickup stops and any driving
buffer. Group size includes you. Equipment is offered only when shareEquipment is
true. Keep real profiles in private/ or outside the repository.

For driving, explicitly fill in car availability. passengerSeats excludes the
driver and must allow for equipment. offerRides enables matching with riders;
maxDetourMinutes limits extra driving and pickup stops each way. An unavailable
car will not be used; change transport if you want to travel another way.

Drivers can optionally add familiar public pickup places under `car`:

```yaml
pickupPoints:
  - name: Library entrance
    location: { lat: 50.076, lon: 14.438 }
```

To request a lift, set transport: ride and remove car. A preferred public point is
optional; if omitted, matching uses points supplied by available drivers. The
planner never assumes a private origin is public. To offer your own candidate:

```yaml
pickup:
  name: Library entrance
  location: { lat: 50.076, lon: 14.438 }
```

The planner prefers feasible driver points, falls back to the rider’s candidate
when needed, and routes your walk to/from the selected pickup and checks maxWalkMinutes including
the final site walk. Pickup names, coordinates and times are shared in Calendar;
private origins remain out of the event. Both outbound and return rides must fit.
Offers remain provisional until the driver and riders confirm them. The Markdown
body is a note, not an input to matching.
