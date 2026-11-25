"use client";

import { useEffect, useRef, useState } from "react";
import { Feedback } from "@/components/ui";
import { OrganizationEmailField } from "@/components/host/organization-email-field";
import type { HostStatus } from "@/server/host-trust/host-check-service";

const TRUSTED_SENTENCE = "Akun Anda tepercaya. Kompetisi yang Anda terbitkan langsung tayang.";
const WAIT_SENTENCE = "Perkiraan 1x24 jam pada hari kerja.";
const NOT_TRUSTED_SENTENCE = `Kompetisi pertama Anda diperiksa staf sebelum tayang. ${WAIT_SENTENCE} Konfirmasi email organisasi agar langsung tayang.`;
const TRUST_REMOVED_SENTENCE =
  "Status tepercaya akun Anda dicabut staf. Kompetisi berikutnya diperiksa staf sebelum tayang.";
const TRUSTED_WORKSPACE_SENTENCE =
  "Kompetisi di ruang kerja yang pemiliknya tepercaya tetap langsung tayang.";

// The server gives the title of the waiting draft only while the host still runs its institution.
const pendingSentence = (competitionTitle: string | undefined): string =>
  competitionTitle === undefined
    ? `Kompetisi Anda sedang diperiksa staf Lombakita. ${WAIT_SENTENCE}`
    : `Kompetisi "${competitionTitle}" sedang diperiksa staf Lombakita. ${WAIT_SENTENCE}`;

type HostStatusCardProps = {
  expectedUserId: string;
  status: HostStatus;
};

// An untrusted host can confirm an Email organisasi here, and the card turns trusted when that
// confirm trusts the account.
export function HostStatusCard({ expectedUserId, status }: HostStatusCardProps) {
  const [trustedByConfirm, setTrustedByConfirm] = useState(false);
  const trustedNoticeRef = useRef<HTMLDivElement>(null);

  // The field unmounts when the card turns trusted, so focus moves to the notice.
  useEffect(() => {
    if (trustedByConfirm) {
      trustedNoticeRef.current?.focus();
    }
  }, [trustedByConfirm]);

  const onConfirmed = (hostTrusted: boolean) => {
    if (hostTrusted) setTrustedByConfirm(true);
  };

  const state = trustedByConfirm ? "trusted" : status.state;

  return (
    <section className="content-section recruiter-tier-card" aria-labelledby="host-status-heading">
      <div className="section-heading">
        <div>
          <h2 id="host-status-heading">Status penyelenggara</h2>
        </div>
      </div>
      {state === "trusted" ? (
        <div ref={trustedNoticeRef} tabIndex={-1}>
          <Feedback tone="success">{TRUSTED_SENTENCE}</Feedback>
        </div>
      ) : null}
      {state === "pending" ? (
        <p className="muted-copy">{pendingSentence(status.competitionTitle)}</p>
      ) : null}
      {state === "trust_removed" ? (
        <Feedback tone="warning">{TRUST_REMOVED_SENTENCE}</Feedback>
      ) : null}
      {state === "not_trusted" ? (
        <div className="stack-md">
          <p className="muted-copy">{NOT_TRUSTED_SENTENCE}</p>
          {status.runsTrustedWorkspace ? (
            <p className="muted-copy">{TRUSTED_WORKSPACE_SENTENCE}</p>
          ) : null}
          <OrganizationEmailField expectedUserId={expectedUserId} onConfirmed={onConfirmed} />
        </div>
      ) : null}
    </section>
  );
}
