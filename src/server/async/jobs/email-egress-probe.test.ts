// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockProbeResendHttp, mockLogInfo } = vi.hoisted(() => ({
  mockProbeResendHttp: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: mockLogInfo, error: vi.fn() },
}));
vi.mock("@/server/email/probe", () => ({ probeResendHttp: mockProbeResendHttp }));

import { processEmailEgressProbeJob, type EmailEgressProbeJob } from "./email-egress-probe";

const job = { id: "probe-job-1", data: { scheduledFor: "30 4 * * *" } } as EmailEgressProbeJob;

/**
 * Each test sets the transport's behaviour itself, and there is deliberately no `beforeEach` that
 * configures this mock.
 *
 * Measured on this file, seven variants against one assertion: an implementation set in a
 * `beforeEach` and then replaced in the test body by one returning a REJECTED promise is reported as
 * an unhandled error — the test fails with the error itself rather than with an assertion, and an
 * intervening `try`/`catch` does not prevent it. The same replacement is green when the hook is
 * empty, when no hook configures the mock, and when the replacement resolves rather than rejects.
 */
const transportSucceeds = () => mockProbeResendHttp.mockImplementation(() => Promise.resolve());
const transportFails = () =>
  mockProbeResendHttp.mockImplementation(() => Promise.reject(new Error("smtp egress refused")));

afterEach(() => vi.clearAllMocks());

describe("processEmailEgressProbeJob", () => {
  it("sends over the HTTP transport the worker actually uses", async () => {
    // Not `probeResend`. Outbound SMTP is blocked from the worker container (LAUNCH-D49), so the
    // scheduled check has to measure the transport that runtime sends through or it reports red
    // every night for a network policy that is not a defect.
    transportSucceeds();

    await processEmailEgressProbeJob(job);

    expect(mockProbeResendHttp).toHaveBeenCalledTimes(1);
  });

  it("reports the successful send without a recipient or a key", async () => {
    transportSucceeds();

    await processEmailEgressProbeJob(job);

    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    const [event, fields] = mockLogInfo.mock.calls[0] ?? [];
    expect(event).toBe("email.egress_probe.ok");
    expect(fields).toEqual({ jobId: "probe-job-1", scheduledFor: "30 4 * * *" });
  });

  // The other half, and the reason this job does not swallow its failure the way the two sweeps do.
  // The finding IS the failure: a probe that logged and returned would leave the worker's failed
  // handler — the only path to Sentry — with nothing to report, and every night would pass silently.
  it("propagates a failed send so the worker's exhaustion path reports it", async () => {
    transportFails();

    await expect(processEmailEgressProbeJob(job)).rejects.toThrow("smtp egress refused");
  });

  it("logs no success line when the send fails", async () => {
    transportFails();

    await expect(processEmailEgressProbeJob(job)).rejects.toThrow();

    expect(mockLogInfo).not.toHaveBeenCalled();
  });
});
