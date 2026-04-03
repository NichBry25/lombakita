import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/scripts/connectors-status");

import { getConnectorStatusPayload } from "@/server/connectors/status";

const includeLiveChecks = process.argv.includes("--live");

const run = async (): Promise<void> => {
  const payload = await getConnectorStatusPayload(includeLiveChecks);

  console.log(JSON.stringify(payload, null, 2));

  const hasBlockingFailure = payload.connectors.some(
    (item) => item.configured && item.live === "down",
  );

  if (hasBlockingFailure) {
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error("Connector status script failed", error);
  process.exitCode = 1;
});
