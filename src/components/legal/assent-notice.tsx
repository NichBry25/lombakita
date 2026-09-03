import Link from "next/link";

/**
 * The line telling someone which terms bind them, shown where they commit to something.
 *
 * Static copy, deliberately. There is no checkbox, no state and no stored acceptance record: the
 * documents are linked at the point of action, and adding a tick box would imply a per-user
 * acceptance the product does not record.
 *
 * `withPaymentTerms` adds the refund position. It belongs only where money is about to move, and
 * it states the rule the product actually enforces: once a bukti transfer is filed, the candidate
 * has no self-service cancellation and no refund on their own initiative.
 */
export function AssentNotice({ withPaymentTerms = false }: { withPaymentTerms?: boolean }) {
  return (
    <div className="assent-notice stack-xs">
      <p>
        Dengan mendaftar, Anda menyetujui{" "}
        <Link href="/syarat-ketentuan">Syarat &amp; Ketentuan</Link> dan{" "}
        <Link href="/kebijakan-privasi">Kebijakan Privasi</Link>.
      </p>
      {withPaymentTerms ? (
        <p>
          Biaya pendaftaran yang sudah dibayarkan tidak dapat dikembalikan atas permintaan Anda
          sendiri.
        </p>
      ) : null}
    </div>
  );
}
