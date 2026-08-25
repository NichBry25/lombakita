/*
 * Attempts one outbound email in a process configured exactly as the Railway worker, and reports
 * whether a request to the provider actually left.
 *
 * Run as a child of the probe suite, never on its own. It exists because "the guard is in the send
 * function" is a claim about a DIFFERENT PROCESS from the one that enqueues: APP_ENV, the delivery
 * flag and every other per-process property belong to whoever set them, and the worker sets its
 * own. Here APP_ENV is `production` and the delivery flag is therefore ON, which is the condition
 * under which a per-process gate would already have let the message through.
 *
 * Nothing can leave the machine: `fetch` is replaced before the app is loaded, so a send ATTEMPT is
 * recorded and answered locally. That recording is the post-state the class-B detector reads —
 * refusing and not refusing differ by whether a request exists, not by which error came back.
 */
const attempts: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  attempts.push(typeof input === "string" ? input : input.toString());
  return new Response(JSON.stringify({ id: "probe-never-sent" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const RESERVED_RECIPIENT = "fixture-01@seed.lombakita.local";

const main = async (): Promise<void> => {
  const { sendRegistrationConfirmedEmail } =
    await import("@/server/notifications/notification-email");

  let refusal = "none";
  try {
    await sendRegistrationConfirmedEmail({
      toEmail: RESERVED_RECIPIENT,
      recipientId: "probe-recipient",
      competitionTitle: "Probe Competition",
      registrationType: "individual",
      registeredAt: new Date(0),
    });
  } catch (error) {
    refusal = error instanceof Error ? error.name : "unknown";
  }

  console.log(
    JSON.stringify({
      refusal,
      attempts,
      appEnv: process.env.APP_ENV,
      runtimeName: process.env.RUNTIME_NAME,
    }),
  );
};

void main();
