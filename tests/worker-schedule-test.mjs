import fs from "node:fs";

const source = fs.readFileSync("cloudflare-worker.js", "utf8");
const worker = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const calls = [];

globalThis.fetch = async (url, options) => {
  calls.push({ url, body: options.body });
  return new Response("", { status: 200 });
};

const kv = { put: async () => {} };

async function run(iso) {
  let task;
  worker.default.scheduled(
    { scheduledTime: Date.parse(iso) },
    { GITHUB_ACTIONS_TOKEN: "test", SECTOR_PULSE_DATA: kv },
    { waitUntil: promise => { task = promise; } },
  );
  if (task) await task;
  return calls.splice(0).map(call => call.url.split("/").at(-2));
}

const cases = [
  ["2026-07-27T13:25:00Z", []],
  ["2026-07-27T13:30:00Z", ["update-market.yml"]],
  ["2026-07-27T20:00:00Z", ["update-market.yml"]],
  ["2026-07-27T20:15:00Z", ["update-history.yml"]],
  ["2026-07-27T20:20:00Z", []],
  ["2026-07-25T14:00:00Z", []],
];

for (const [iso, expected] of cases) {
  const actual = await run(iso);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${iso}: ${actual} != ${expected}`);
  }
}

process.stdout.write("Cloudflare schedule boundary simulation passed\n");
