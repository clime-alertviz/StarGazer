import { resolve } from "node:path";
import { Store } from "../web/server/store.js";
import { Community } from "../web/server/community.js";
import { seedCommunity } from "../web/server/seed.js";

const directory = resolve(
  process.env.STAR_GAZER_DEMO_DATA_DIR || "private/community-demo",
);
const store = await new Store(directory).load();
if (process.argv.includes("--reset")) {
  if (!directory.endsWith("/community-demo"))
    throw new Error(
      "Reset is restricted to the separate community-demo directory.",
    );
  store.community = {
    version: 1,
    users: [],
    connections: [],
    outings: [],
    messages: [],
    sessions: [],
    tokens: [],
    grants: [],
    oauth: [],
    audit: [],
  };
}
console.log(await seedCommunity(new Community(store)));
store.close();
