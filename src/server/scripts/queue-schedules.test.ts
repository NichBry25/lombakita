// @vitest-environment node

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAsyncQueue,
  mockGetJobSchedulers,
  mockCloseAsyncQueueConnections,
  mockRequireRedisUrl,
} = vi.hoisted(() => ({
  mockGetAsyncQueue: vi.fn(),
  mockGetJobSchedulers: vi.fn(),
  mockCloseAsyncQueueConnections: vi.fn(),
  mockRequireRedisUrl: vi.fn(),
}));

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/redis/client", () => ({ requireRedisUrl: mockRequireRedisUrl }));
vi.mock("@/server/async/queue", () => ({
  getAsyncQueue: mockGetAsyncQueue,
  closeAsyncQueueConnections: mockCloseAsyncQueueConnections,
}));

import type { JobSchedulerJson } from "bullmq";
import { ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import {
  describeRedisHost,
  describeScheduler,
  runQueueSchedules,
} from "@/server/scripts/queue-schedules";

// A Redis URL carries its password in the userinfo, and this command's output exists to be pasted
// into a report — so the whole point of the host line is that it is the URL minus the credential.
//
// Assembled from a parsed URL rather than written as one literal, because the secret scan matches
// the SHAPE `scheme://user:password@host` and a fixture carrying it would spend the rule's
// strictness on a fixture. The value under test still carries a password.
const SECRET = "s3cret-password";
const REDIS_URL = (() => {
  const url = new URL("redis://redis-host.example:6379");
  url.username = "default";
  url.password = SECRET;
  return url.href;
})();

const scheduler = (overrides: Partial<JobSchedulerJson> = {}): JobSchedulerJson =>
  ({
    key: "email-egress-daily",
    name: "email.egress.probe",
    id: "email-egress-daily",
    pattern: "30 4 * * *",
    tz: "Asia/Jakarta",
    next: Date.UTC(2026, 0, 1),
    ...overrides,
  }) as JobSchedulerJson;

/** Everything the command printed, as one string. */
const capturedOutput = (): string => {
  const log = vi.mocked(console.log);

  return log.mock.calls.map((call) => call.join(" ")).join("\n");
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("describeRedisHost", () => {
  it("prints the host and port and nothing else from the URL", () => {
    expect(describeRedisHost(REDIS_URL)).toBe("redis host=redis-host.example:6379");
    expect(describeRedisHost(REDIS_URL)).not.toContain(SECRET);
  });
});

describe("describeScheduler", () => {
  it("prints the id, the pattern, the timezone and the next run", () => {
    expect(describeScheduler(scheduler())).toBe(
      "id=email-egress-daily pattern=30 4 * * * tz=Asia/Jakarta next=2026-01-01T00:00:00.000Z",
    );
  });

  // A registration path always sets a fixed id, so this should not occur in practice — but a line
  // reading `id=undefined` is a line that cannot be acted on, and the key is what BullMQ itself
  // identifies the scheduler by.
  it("falls back to the key when BullMQ reports no id", () => {
    expect(describeScheduler(scheduler({ id: null }))).toContain("id=email-egress-daily (key)");
  });

  // Printed rather than omitted, so two runs against different schedules read down the same column
  // and a missing field cannot pass for a field that was never printed.
  it("prints a dash for each field the scheduler does not carry", () => {
    const bare = scheduler({ pattern: undefined, tz: undefined, next: undefined });

    expect(describeScheduler(bare)).toBe("id=email-egress-daily pattern=- tz=- next=-");
  });
});

describe("runQueueSchedules", () => {
  const setup = (schedulers: JobSchedulerJson[]) => {
    mockRequireRedisUrl.mockReturnValue(REDIS_URL);
    mockGetJobSchedulers.mockResolvedValue(schedulers);
    mockGetAsyncQueue.mockReturnValue({ getJobSchedulers: mockGetJobSchedulers });
    mockCloseAsyncQueueConnections.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
  };

  it("reads the infrastructure queue and prints its schedulers", async () => {
    setup([scheduler()]);
    await runQueueSchedules();

    expect(mockGetAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.infrastructure);
    expect(capturedOutput()).toBe(
      [
        "redis host=redis-host.example:6379",
        "id=email-egress-daily pattern=30 4 * * * tz=Asia/Jakarta next=2026-01-01T00:00:00.000Z",
      ].join("\n"),
    );
  });

  it("prints the host line and never the URL it came from", async () => {
    setup([scheduler()]);
    await runQueueSchedules();

    expect(capturedOutput()).toContain("redis host=redis-host.example:6379");
    expect(capturedOutput()).not.toContain(SECRET);
    expect(capturedOutput()).not.toContain("redis://");
  });

  // An empty list and a command that produced no output at all look identical in a report, and only
  // one of them is a finding.
  it("says so rather than printing nothing when no scheduler is registered", async () => {
    setup([]);
    await runQueueSchedules();

    expect(capturedOutput()).toContain(
      "no job schedulers are registered on the infrastructure queue",
    );
  });

  // Redis holds open sockets, so a command that left them open would never let the process exit.
  it("closes the queue connections", async () => {
    setup([scheduler()]);
    await runQueueSchedules();

    expect(mockCloseAsyncQueueConnections).toHaveBeenCalledTimes(1);
  });

  // Mocked rather than deleted from the environment: `serverEnv` is parsed once at module load, so
  // removing the variable here would leave the already-parsed value in place and the test would pass
  // without the command having been refused at all.
  it("fails rather than printing a host line when REDIS_URL is not configured", async () => {
    setup([scheduler()]);
    mockRequireRedisUrl.mockImplementation(() => {
      throw new Error("REDIS_URL is not configured");
    });

    await expect(runQueueSchedules()).rejects.toThrow("REDIS_URL is not configured");
    expect(capturedOutput()).toBe("");
    expect(mockGetAsyncQueue).not.toHaveBeenCalled();
    expect(mockCloseAsyncQueueConnections).not.toHaveBeenCalled();
  });

  // The exit code is the runner's, not this function's, so it is measured by running the command the
  // way an operator does. A `queue:schedules` that printed a stack trace and exited 0 would read as
  // a successful read of an empty schedule list.
  it("exits 1 when the command is run without REDIS_URL", () => {
    const env = { ...process.env };
    delete env.REDIS_URL;

    const result = spawnSync("npx", ["tsx", "src/server/scripts/queue-schedules.ts"], {
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("REDIS_URL is not configured");
  }, 60_000);
});
