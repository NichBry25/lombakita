"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui";

// Step 6.5.1 — homepage notification bell. Polls the lightweight unread-count endpoint, shows a
// badge, and plays a short audio ping when the unread count rises (a new notification/invitation
// arrived). Self-hides for unauthenticated visitors (the endpoint returns 401). Real-time delivery
// (websockets/SSE) is out of scope — a periodic poll is the MVP mechanism.
//
// Audio note: browsers block audio until the user interacts with the page, so the AudioContext is
// unlocked on the first pointer/key event. A ping that fires before any interaction is silently
// dropped (caught), which is the expected browser behaviour.

const POLL_INTERVAL_MS = 25_000;

type AudioCtor = typeof AudioContext;

const getAudioCtor = (): AudioCtor | undefined => {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
  );
};

export function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [authed, setAuthed] = useState(true);
  const prevCountRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Unlock audio on the first user gesture (browser autoplay policy).
  useEffect(() => {
    const unlock = () => {
      const Ctor = getAudioCtor();
      if (!Ctor) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctor();
      void audioCtxRef.current.resume();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const playPing = () => {
    try {
      const Ctor = getAudioCtor();
      if (!Ctor) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctor();
      const ctx = audioCtxRef.current;
      void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch {
      // Autoplay blocked or Web Audio unsupported — ignore.
    }
  };

  useEffect(() => {
    let active = true;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const stopPolling = () => {
      if (intervalId !== undefined) clearInterval(intervalId);
      intervalId = undefined;
    };

    const poll = async () => {
      try {
        const res = await fetch("/api/v1/me/inbox/unread-count", { credentials: "include" });
        if (!active) return;
        if (res.status === 401) {
          // Signed out: stop polling entirely rather than 401ing every 25 s for the life of the
          // tab. Signing in remounts this component, which starts a fresh interval.
          setAuthed(false);
          stopPolling();
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as { unreadCount?: unknown };
        const count = typeof body.unreadCount === "number" ? body.unreadCount : 0;
        setAuthed(true);
        if (prevCountRef.current !== null && count > prevCountRef.current) {
          playPing();
        }
        prevCountRef.current = count;
        setUnreadCount(count);
      } catch {
        // Network error — keep prior state, try again next interval.
      }
    };

    void poll();
    intervalId = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      stopPolling();
    };
  }, []);

  if (!authed) return null;

  const hasUnread = typeof unreadCount === "number" && unreadCount > 0;

  return (
    // Not an IconButtonLink: the unread badge is an extra child that the primitive has no slot
    // for. It mirrors the primitive's class and icon size so it matches its header siblings.
    <Link
      href="/inbox"
      className="ui-icon-button notification-link"
      data-variant="ghost"
      data-size="md"
      aria-label={hasUnread ? `Kotak masuk, ${unreadCount} belum dibaca` : "Kotak masuk"}
    >
      <Icon name="inbox" />
      {hasUnread ? <span className="notification-badge">{unreadCount}</span> : null}
    </Link>
  );
}
