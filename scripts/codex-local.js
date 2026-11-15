import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Pass only StarGazer client settings, never server Google/SMTP secrets.
let file = {};
try {
  file = parseEnv(
    await readFile(new URL("../.env", import.meta.url), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const env = { ...process.env };
for (const key of [
  "STAR_GAZER_URL",
  "STAR_GAZER_TOKEN",
  "GEOAPIFY_API_KEY",
  "OPEN_METEO_API_KEY",
])
  if (!env[key] && file[key]) env[key] = file[key];
const child = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL(
        "../node_modules/@openai/codex/bin/codex.js",
        import.meta.url,
      ),
    ),
    ...process.argv.slice(2),
  ],
  { env, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
