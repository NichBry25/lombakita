import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/payment-expiry-sweep");

import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type PaymentExpirySweepPayload } from "@/server/async/contracts";
import { sweepExpiredPayments } from "@/server/finance/payment-expiry-service";

export type PaymentExpirySweepJob = Job<
  PaymentExpirySweepPayload,
  void,
  typeof ASYNC_JOB_NAMES.paymentExpirySweep
>;

/**
 * Ends the registrations whose bukti transfer deadline has passed with nothing submitted.
 *
 * A THIN WRAPPER ON PURPOSE. Every decision (which payments are overdue, whether a pending proof
 * suspends expiry, the row lock that serialises against a candidate uploading at the boundary)
 * lives in `sweepExpiredPayments`, where it is testable against a real database without a queue.
 * A job handler that carried any of that logic could only be tested through BullMQ.
 *
 * The sweep isolates per-payment failures itself and reports them in its result, so this does not
 * rethrow: letting the error propagate would ask BullMQ to retry the whole sweep, re-walking every
 * payment that already expired successfully. The next scheduled run is the retry, and it costs
 * nothing, because a deadline does not move, so an overdue payment stays selectable until it is
 * expired or paid.
 */
export const processPaymentExpirySweepJob = async (job: PaymentExpirySweepJob): Promise<void> => {
  const result = await sweepExpiredPayments();

  logger.info("payment.expiry.job_completed", {
    jobId: job.id,
    examined: result.examined,
    expired: result.expired.length,
    skipped: result.skipped,
    registrationsCancelled: result.expired.reduce(
      (total, outcome) => total + outcome.registrationsCancelled,
      0,
    ),
  });
};
