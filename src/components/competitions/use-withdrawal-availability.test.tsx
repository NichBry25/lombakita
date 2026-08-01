import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWithdrawalAvailability } from "@/components/competitions/use-withdrawal-availability";

const NOW = new Date("2026-07-30T12:00:00.000Z");

const Probe = ({
  eventStartAt,
  participantConfirmationAt = null,
  hasActiveRegistrations,
}: {
  eventStartAt: string | null;
  participantConfirmationAt?: string | null;
  hasActiveRegistrations: boolean;
}) => {
  const canWithdraw = useWithdrawalAvailability({
    eventStartAt,
    participantConfirmationAt,
    hasActiveRegistrations,
  });
  return <span data-testid="state">{canWithdraw ? "allowed" : "blocked"}</span>;
};

const state = () => screen.getByTestId("state").textContent;

describe("useWithdrawalAvailability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts allowed before the event and flips to blocked at the start instant", () => {
    const start = new Date(NOW.getTime() + 60_000).toISOString();
    render(<Probe eventStartAt={start} hasActiveRegistrations />);
    expect(state()).toBe("allowed");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(state()).toBe("blocked");
  });

  it("does not flip early — a console open across an hour stays allowed", () => {
    const start = new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString();
    render(<Probe eventStartAt={start} hasActiveRegistrations />);

    act(() => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(state()).toBe("allowed");
  });

  it("does not flip early for a start beyond the 32-bit setTimeout ceiling", () => {
    // ~60 days out. A single unclamped setTimeout would overflow and fire immediately, disabling
    // the control two months before the event.
    const start = new Date(NOW.getTime() + 60 * 24 * 60 * 60_000).toISOString();
    render(<Probe eventStartAt={start} hasActiveRegistrations />);
    expect(state()).toBe("allowed");

    act(() => {
      vi.advanceTimersByTime(2 ** 31 - 1);
    });
    expect(state()).toBe("allowed");

    act(() => {
      vi.advanceTimersByTime(60 * 24 * 60 * 60_000);
    });
    expect(state()).toBe("blocked");
  });

  it("becomes unavailable at participantConfirmationAt even before the event starts", () => {
    const confirmation = new Date(NOW.getTime() + 60_000).toISOString();
    const start = new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString();
    render(
      <Probe
        eventStartAt={start}
        participantConfirmationAt={confirmation}
        hasActiveRegistrations={false}
      />,
    );
    expect(state()).toBe("allowed");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(state()).toBe("blocked");
  });

  it("stays allowed past the start when nobody is registered", () => {
    const start = new Date(NOW.getTime() + 60_000).toISOString();
    render(<Probe eventStartAt={start} hasActiveRegistrations={false} />);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(state()).toBe("allowed");
  });

  it("reports blocked immediately for an already-started competition", () => {
    const start = new Date(NOW.getTime() - 60_000).toISOString();
    render(<Probe eventStartAt={start} hasActiveRegistrations />);
    expect(state()).toBe("blocked");
  });

  it("re-checks when a backgrounded tab becomes visible again", () => {
    const start = new Date(NOW.getTime() + 60_000).toISOString();
    render(<Probe eventStartAt={start} hasActiveRegistrations />);
    expect(state()).toBe("allowed");

    // Simulate a throttled tab: the clock moves past the start without the timer firing.
    act(() => {
      vi.setSystemTime(new Date(NOW.getTime() + 120_000));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(state()).toBe("blocked");
  });

  it("allows withdrawal when no start date is set", () => {
    render(<Probe eventStartAt={null} hasActiveRegistrations />);
    expect(state()).toBe("allowed");
  });
});
