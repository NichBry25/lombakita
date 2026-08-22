import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/connectors/status");

import { isAsyncWorkersConfigured, probeAsyncWorkerLiveness } from "@/server/async/probe";
import {
  isMfaEncryptionConfigured,
  probeMfaEncryption,
} from "@/server/auth/mfa/mfa-encryption-probe";
import { runConnectorProbe, type ConnectorReadiness } from "@/server/connectors/shared";
import { isDatabaseConfigured, probeDatabase } from "@/server/db/probe";
import { isResendConfigured, probeResend } from "@/server/email/probe";
import { isSentryConfigured, probeSentry } from "@/server/observability/probe";
import { isRedisConfigured, probeRedis } from "@/server/redis/probe";
import { isMeilisearchConfigured, probeMeilisearch } from "@/server/search/probe";
import { isR2Configured, probeR2 } from "@/server/storage/probe";

export type ConnectorStatusPayload = {
  connectors: ConnectorReadiness[];
  summary: {
    configured: number;
    liveUp: number;
    liveDown: number;
  };
};

export type ConnectorStatusOptions = {
  includeLiveChecks: boolean;
  /**
   * Worker liveness enqueues a real job and waits up to 20s for a worker to consume it. That side
   * effect and that latency are why it is opt-in rather than part of the live set, and why the
   * deploy gate leaves it off: the gate runs in the same job that is about to redeploy the worker,
   * so a redeploy in flight would fail a check measuring the outgoing process.
   */
  includeWorkerLiveness: boolean;
};

export const getConnectorStatusPayload = async (
  options: ConnectorStatusOptions,
): Promise<ConnectorStatusPayload> => {
  const { includeLiveChecks, includeWorkerLiveness } = options;

  const connectors = await Promise.all([
    runConnectorProbe({
      name: "postgres",
      configured: isDatabaseConfigured(),
      includeLiveChecks,
      probe: probeDatabase,
      // The only connector that scales to zero, so the first connection after an idle period can
      // exceed the client's 10s connect timeout while the compute wakes. A second attempt finds it
      // awake. See the retries note on runConnectorProbe for the dual-stack half of the reason.
      retries: 1,
    }),
    runConnectorProbe({
      name: "redis",
      configured: isRedisConfigured(),
      includeLiveChecks,
      probe: probeRedis,
    }),
    runConnectorProbe({
      name: "meilisearch",
      configured: isMeilisearchConfigured(),
      includeLiveChecks,
      probe: probeMeilisearch,
    }),
    runConnectorProbe({
      name: "r2",
      configured: isR2Configured(),
      includeLiveChecks,
      probe: probeR2,
    }),
    runConnectorProbe({
      name: "resend",
      configured: isResendConfigured(),
      includeLiveChecks,
      probe: probeResend,
    }),
    runConnectorProbe({
      name: "sentry",
      configured: isSentryConfigured(),
      includeLiveChecks,
      probe: probeSentry,
    }),
    runConnectorProbe({
      name: "mfa-encryption",
      configured: isMfaEncryptionConfigured(),
      includeLiveChecks,
      probe: probeMfaEncryption,
    }),
    runConnectorProbe({
      name: "worker",
      configured: isAsyncWorkersConfigured(),
      includeLiveChecks: includeLiveChecks && includeWorkerLiveness,
      probe: probeAsyncWorkerLiveness,
    }),
  ]);

  const summary = {
    configured: connectors.filter((item) => item.configured).length,
    liveUp: connectors.filter((item) => item.live === "up").length,
    liveDown: connectors.filter((item) => item.live === "down").length,
  };

  return {
    connectors,
    summary,
  };
};
