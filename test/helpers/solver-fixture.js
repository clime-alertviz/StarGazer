import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../web/server/store.js";
import { Community } from "../../web/server/community.js";
import { SolverBackends } from "../../web/server/solvers/index.js";

export async function solverFixture(runtime, { backend = "codex" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sg-solver-"));
  const store = await new Store(directory).load();
  const day = new Date(Date.now() + 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const start = `${day}T16:00:00Z`,
    end = new Date(Date.parse(start) + 10 * 3600000).toISOString();
  const geo = {
    call: async (name, args) => {
      if (name === "list_place_categories")
        return { categories: ["tourism.attraction.viewpoint"] };
      if (name === "search_places")
        return {
          features: [
            {
              properties: {
                name: "Central meadow",
                lat: 50.1,
                lon: 14.4,
              },
            },
            {
              properties: {
                name: "Quiet hill",
                lat: 50.12,
                lon: 14.42,
              },
            },
          ],
        };
      const units = {
        time_units: "seconds",
        distance_units: "meters",
      };
      if (name === "calculate_route_matrix")
        return {
          ...units,
          sources_to_targets: args.sources.map(() =>
            args.targets.map(() => ({ time: 300, distance: 500 })),
          ),
        };
      return {
        ...units,
        time: (args.waypoints.length - 1) * 300,
        distance: 500,
        legs: args.waypoints
          .slice(1)
          .map(() => ({ time: 300, distance: 500 })),
      };
    },
  };
  const forecast = async () => ({
    source: "Test fixture",
    fetchedAt: new Date().toISOString(),
    hours: Array.from({ length: 400 }, (_, i) => ({
      at: new Date(
        Math.floor(Date.now() / 3600000) * 3600000 + i * 3600000,
      ).toISOString(),
      cloud_cover: 5,
      wind_speed_10m: 5,
      temperature_2m: 8,
      precipitation_probability: 0,
      precipitation: 0,
      visibility: 20000,
    })),
  });
  const solvers = new SolverBackends({
    directory,
    defaultBackend: backend,
    runtime,
    rankingDelay: 0,
  });
  const hub = new Community(store, {
    geo,
    forecast,
    solvers,
    providers: {
      status: () => ({
        googleConnected: false,
        email: "local_outbox",
      }),
      mail: async () => ({ delivery: "local_only" }),
    },
  });
  hub.setBase("http://127.0.0.1:4319");
  const owner = hub.identity.user("owner@solver.test");
  await hub.saveProfile(owner.id, {
    name: "Alex",
    avatar: "star",
    timezone: "Europe/Prague",
    interests: ["Photography", "Stargazing"],
    interestNote: "Prefer a quiet photography session with a good view.",
    experience: "beginner",
    happyToTeach: false,
    equipment: ["camera", "tripod"],
    shareEquipment: true,
    channel: "email",
    origin: {
      name: "Public station",
      location: { lat: 50.1, lon: 14.4 },
    },
    slots: [{ date: day, from: "17:00", until: "03:00", weekly: false }],
    travel: ["walk"],
    maxTravelMinutes: 60,
    maxWalkMinutes: 30,
    preference: "balanced",
  });
  return {
    directory,
    store,
    hub,
    owner,
    day,
    start,
    end,
    geo,
    forecast,
    solvers,
    input: {
      target: "stargazing",
      start,
      end,
      minPeople: 2,
      maxPeople: 4,
      visibility: "open",
      participantIds: [],
    },
    close: async () => {
      hub.closing = true;
      solvers.close();
      await hub.planningJobs.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
