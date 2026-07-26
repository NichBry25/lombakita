"use client";

import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";
import { Spinner } from "./spinner";

/**
 * Leading slot for `ButtonLink`. While the Link's navigation is in flight it renders the
 * spinner; otherwise it renders whatever leading icon the caller passed.
 *
 * `useLinkStatus` only reports pending state for a client-side navigation started by the
 * enclosing `<Link>`, so this must stay a descendant of that Link. It is isolated in its own
 * client module so `button.tsx` remains importable from server components.
 */
export function LinkPendingSlot({ leadingIcon }: { leadingIcon?: ReactNode }) {
  const { pending } = useLinkStatus();

  if (pending) {
    return <Spinner size="sm" />;
  }

  return <>{leadingIcon}</>;
}
