import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/email-egress-probe");

import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type EmailEgressProbePayload } from "@/server/async/contracts";
import { probeResendHttp } from "@/server/email/probe";

export type EmailEgressProbeJob = Job<
  EmailEgressProbePayload,
  void,
  typeof ASYNC_JOB_NAMES.emailEgressProbe
>;

/**
 * The daily check that this runtime can still send over the transport it actually uses.
 *
 * A THIN WRAPPER ON PURPOSE, and it holds no logic beyond the call: what is being measured is the
 * provider relationship of the process the job runs in, so anything standing between the job and the
 * send would be measuring itself.
 *
 * IT RETHROWS, UNLIKE `payment-expiry-sweep`. That job's subject is a set of rows it isolates itself
 * and can re-walk tomorrow, so a BullMQ retry would only repeat work that already succeeded. Here
 * the failure IS the finding: there is nothing to isolate, a retry is the honest response to a
 * provider blip, and the third failed attempt is what reaches Sentry through the worker's failed
 * handler. Swallowing it would leave the one signal this job exists to produce sitting in a log.
 *
 * The success line carries no recipient and no key — the address this sends to is a Resend simulator
 * mailbox, and naming it here would put a deliverable address in the log of every nightly run.
 */
export const processEmailEgressProbeJob = async (job: EmailEgressProbeJob): Promise<void> => {
  await probeResendHttp();

  logger.info("email.egress_probe.ok", {
    jobId: job.id,
    scheduledFor: job.data.scheduledFor,
  });
};
