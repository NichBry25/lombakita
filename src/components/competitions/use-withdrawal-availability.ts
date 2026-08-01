"use client";

import { useEffect, useReducer } from "react";
import {
  canWithdrawPublication,
  type WithdrawalEligibilityInput,
} from "@/lib/competitions/competition-withdrawal";

// setTimeout stores its delay in a signed 32-bit int. A larger delay wraps and fires almost
// immediately, so a boundary two months out would otherwise flip the control the moment the page
// loaded. Long waits are served by re-arming at this ceiling until the boundary is actually
// reached.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// Keeps the organizer console's withdrawal affordance honest against the clock.
//
// A competition console can sit open across the event's start time, and a value computed once at
// render would still offer withdrawal an hour into the competition. The answer itself is derived
// during render, so it always reflects the current props; the effect exists only to schedule a
// re-render at the one instant the answer can change on its own.
//
// This is presentation only. `unpublishCompetition` enforces the same rule server-side, so a stale
// tab can at worst produce a refused request, never a withdrawal that should not have happened.
export const useWithdrawalAvailability = (input: WithdrawalEligibilityInput): boolean => {
  const { eventStartAt, participantConfirmationAt = null, hasActiveRegistrations } = input;
  // The count is never read — bumping it is how the boundary asks for a fresh render.
  const [, recheck] = useReducer((tick: number) => tick + 1, 0);

  useEffect(() => {
    const startTime = eventStartAt === null ? null : new Date(eventStartAt).getTime();
    const confirmationTime =
      participantConfirmationAt === null ? null : new Date(participantConfirmationAt).getTime();
    const futureBoundaries = [
      ...(hasActiveRegistrations && startTime !== null && Number.isFinite(startTime)
        ? [startTime]
        : []),
      ...(confirmationTime !== null && Number.isFinite(confirmationTime) ? [confirmationTime] : []),
    ].filter((boundary) => boundary > Date.now());
    const nextBoundary = futureBoundaries.length > 0 ? Math.min(...futureBoundaries) : null;
    if (nextBoundary === null) return;

    let timer: ReturnType<typeof setTimeout>;

    const arm = () => {
      const remaining = nextBoundary - Date.now();
      timer = setTimeout(
        () => {
          recheck();
          // Re-arm rather than assume the boundary was reached: a clamped long wait fires early by
          // design, and a suspended machine fires its timers late.
          if (Date.now() < nextBoundary) arm();
        },
        Math.min(Math.max(remaining, 0), MAX_TIMEOUT_MS),
      );
    };

    arm();

    // A backgrounded tab may have its timers throttled or deferred; re-checking on return covers
    // the gap without a polling interval.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") recheck();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [eventStartAt, hasActiveRegistrations, participantConfirmationAt]);

  return canWithdrawPublication({
    eventStartAt,
    participantConfirmationAt,
    hasActiveRegistrations,
  });
};
