import Link from "next/link";
import { Feedback } from "@/components/ui";
import type { ChargingBlocker } from "@/server/finance/charging-readiness";

/**
 * Why this institution cannot charge, and what to do about each reason.
 *
 * A PAID COMPETITION OWNED BY AN UNVERIFIED INSTITUTION IS A DEFINED STATE, not an error to hide.
 * Verification can be revoked after competitions were priced and published, so the organiser needs
 * to be told what changed before a candidate discovers it by failing to register.
 *
 * THE FIRST LINE IS THE MOST IMPORTANT ONE. Verification gates CHARGING, never publishing: nothing
 * here takes a competition down, and an organiser reading "your institution is not verified" will
 * assume it did unless the copy says otherwise in the same breath.
 *
 * The fee-rule blocker is deliberately the one with no self-service action. It is Lombakita's
 * configuration, not the organiser's, and offering them a button would send them looking for a
 * setting that does not exist.
 */
export function ChargingReadinessPanel({
  blockers,
  institutionSlug,
}: {
  blockers: ChargingBlocker[];
  institutionSlug: string;
}) {
  if (blockers.length === 0) return null;

  const base = `/institution/${institutionSlug}`;

  const ACTIONS: Record<ChargingBlocker, { what: string; action: React.ReactNode }> = {
    institution_unverified: {
      what: "Institusi ini belum terverifikasi.",
      action: <Link href={`${base}/verification`}>Ajukan verifikasi</Link>,
    },
    payment_instructions_missing: {
      what: "Informasi pembayaran belum diisi, sehingga peserta tidak punya tujuan transfer.",
      action: <Link href={`${base}/settings`}>Isi informasi pembayaran</Link>,
    },
    fee_rule_not_in_force: {
      what: "Tarif layanan Lombakita belum dikonfigurasi.",
      action: <span className="muted-copy">Hubungi tim Lombakita. Ini bukan pengaturan Anda.</span>,
    },
  };

  return (
    <Feedback tone="warning">
      <div className="stack-sm">
        <p>
          <strong>Pendaftaran berbayar belum dapat diaktifkan.</strong> Kompetisi yang sudah terbit
          tetap tayang dan tidak diturunkan. Yang tertahan hanya kemampuan memungut biaya
          pendaftaran baru.
        </p>
        <ul className="stack-xs">
          {blockers.map((blocker) => (
            <li key={blocker}>
              {ACTIONS[blocker].what} {ACTIONS[blocker].action}
            </li>
          ))}
        </ul>
      </div>
    </Feedback>
  );
}
