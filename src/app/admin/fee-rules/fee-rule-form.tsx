"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Feedback,
  FormActionBar,
  FormField,
  FormHelp,
  FormInput,
  FormLabel,
  Icon,
  IconButton,
  SelectField,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { computePlatformFee, findFeeRuleRejection, type FeeRuleTerms } from "@/lib/finance/fee";
import { SUPPORTED_CURRENCIES } from "@/lib/finance/money";
import type { FeeRuleErrorCode } from "@/server/finance/fee-rule-service";
import { formatBasisPoints, formatMinorUnits } from "./fee-rule-display";

// A representative sale used only to show the operator what their terms would charge. Nothing is
// stored from it and no payment uses it. It exists so a rate is legible as money before it is
// saved, rather than as an abstract basis-point figure.
const PREVIEW_GROSS_AMOUNT = 100_000;

const SCOPE_OPTIONS = [
  { value: "global", label: "Global (semua institusi)" },
  { value: "institution", label: "Institusi tertentu" },
];

const CURRENCY_OPTIONS = SUPPORTED_CURRENCIES.map((code) => ({ value: code, label: code }));

// The endpoint answers with a stable machine code beside an English developer message. The operator
// reads the Indonesian line keyed off that code; the developer message is never surfaced. Codes
// createFeeRule cannot raise are deliberately absent and fall through to the generic line, and the
// `satisfies` clause makes a key that no longer matches a server code a compile error.
const ERROR_MESSAGES: Record<string, string> = {
  fee_rule_takes_entire_payment:
    "Tarif ini mengambil seluruh pembayaran. Institusi tidak menerima apa pun dari penjualannya sendiri, jadi aturan ini ditolak.",
  fee_rule_terms_invalid:
    "Nilai aturan tidak valid. Setiap nominal harus bilangan bulat dan tidak boleh negatif.",
  fee_rule_effective_window_invalid:
    "Rentang berlaku tidak valid. Tanggal mulai wajib diisi dan tanggal berakhir harus setelah tanggal mulai.",
  fee_rule_currency_unsupported: "Mata uang ini belum didukung.",
  fee_rule_institution_not_found: "Institusi tidak ditemukan. Periksa kembali ID institusi.",
} satisfies Partial<Record<FeeRuleErrorCode, string>>;

const messageFor = (code: string | undefined, status: number): string =>
  (code && ERROR_MESSAGES[code]) ?? `Aturan gagal disimpan (${status}).`;

// A blank optional amount is null, not zero: "no maximum" and "a maximum of nothing" are different
// rules, and coercing the first into the second would cap every fee at zero.
const toOptionalAmount = (raw: string): number | null => {
  const trimmed = raw.trim();

  return trimmed === "" ? null : Number(trimmed);
};

const toAmount = (raw: string): number => {
  const trimmed = raw.trim();

  return trimmed === "" ? 0 : Number(trimmed);
};

export function FeeRuleForm() {
  const router = useRouter();
  const { addToast } = useToast();

  const [scope, setScope] = useState("global");
  const [institutionId, setInstitutionId] = useState("");
  const [currency, setCurrency] = useState<string>(SUPPORTED_CURRENCIES[0]);
  const [basisPoints, setBasisPoints] = useState("250");
  const [flatAmount, setFlatAmount] = useState("0");
  const [minimumFeeAmount, setMinimumFeeAmount] = useState("");
  const [maximumFeeAmount, setMaximumFeeAmount] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [saving, setSaving] = useState(false);

  // Recomputed as the operator types, through the SAME pure function the server prices with, so the
  // preview cannot drift from what the rule would actually do.
  const preview = useMemo(() => {
    const terms: FeeRuleTerms = {
      basisPoints: toAmount(basisPoints),
      flatAmount: toAmount(flatAmount),
      minimumFeeAmount: toOptionalAmount(minimumFeeAmount),
      maximumFeeAmount: toOptionalAmount(maximumFeeAmount),
      currency: currency as FeeRuleTerms["currency"],
    };

    if (!Number.isSafeInteger(terms.basisPoints) || terms.basisPoints < 0) {
      return null;
    }

    if (findFeeRuleRejection(terms) === "fee_rule_takes_entire_payment") {
      return { rejected: true as const };
    }

    try {
      const computed = computePlatformFee(PREVIEW_GROSS_AMOUNT, terms);

      return {
        rejected: false as const,
        fee: computed.platformFeeAmount,
        net: computed.institutionNetAmount,
      };
    } catch {
      return null;
    }
  }, [basisPoints, flatAmount, minimumFeeAmount, maximumFeeAmount, currency]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);

    try {
      const response = await fetch("/api/platform-ops/fee-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          institutionId: scope === "institution" ? institutionId.trim() : null,
          currency,
          basisPoints: toAmount(basisPoints),
          flatAmount: toAmount(flatAmount),
          minimumFeeAmount: toOptionalAmount(minimumFeeAmount),
          maximumFeeAmount: toOptionalAmount(maximumFeeAmount),
          effectiveFrom: effectiveFrom === "" ? "" : new Date(effectiveFrom).toISOString(),
          effectiveTo: effectiveTo === "" ? null : new Date(effectiveTo).toISOString(),
        }),
      });

      const data = (await response.json()) as { error?: { code?: string } };

      if (!response.ok) {
        addToast({
          type: "error",
          message: messageFor(data?.error?.code, response.status),
        });
        return;
      }

      addToast({ type: "success", message: "Aturan biaya tersimpan." });
      setInstitutionId("");
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan jaringan." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="fee-rule-form">
      <div className="form-grid fee-rule-form-grid">
        <FormField>
          <FormLabel htmlFor="fee-rule-scope" required>
            Cakupan
          </FormLabel>
          <SelectField
            id="fee-rule-scope"
            label="Cakupan aturan biaya"
            options={SCOPE_OPTIONS}
            value={scope}
            onChange={setScope}
          />
          <FormHelp>Aturan institusi mengalahkan aturan global saat keduanya berlaku.</FormHelp>
        </FormField>

        {scope === "institution" && (
          <FormField>
            <FormLabel htmlFor="fee-rule-institution" required>
              ID institusi
            </FormLabel>
            <FormInput
              id="fee-rule-institution"
              value={institutionId}
              onChange={(event) => setInstitutionId(event.target.value)}
              required
            />
            <FormHelp>Institusi yang tidak ditemukan akan ditolak saat disimpan.</FormHelp>
          </FormField>
        )}

        <FormField>
          <FormLabel htmlFor="fee-rule-currency" required>
            Mata uang
          </FormLabel>
          <SelectField
            id="fee-rule-currency"
            label="Mata uang aturan biaya"
            options={CURRENCY_OPTIONS}
            value={currency}
            onChange={setCurrency}
          />
        </FormField>

        <FormField>
          <FormLabel htmlFor="fee-rule-basis-points" required>
            Tarif (basis poin)
          </FormLabel>
          <FormInput
            id="fee-rule-basis-points"
            type="number"
            inputMode="numeric"
            min={0}
            max={10_000}
            step={1}
            value={basisPoints}
            onChange={(event) => setBasisPoints(event.target.value)}
            required
          />
          <FormHelp>
            100 basis poin = 1%. Saat ini {formatBasisPoints(toAmount(basisPoints))}.
          </FormHelp>
        </FormField>

        <FormField>
          <FormLabel htmlFor="fee-rule-flat">Biaya tetap</FormLabel>
          <FormInput
            id="fee-rule-flat"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={flatAmount}
            onChange={(event) => setFlatAmount(event.target.value)}
          />
          <FormHelp>Ditambahkan di atas komponen persentase.</FormHelp>
        </FormField>

        <FormField>
          <FormLabel htmlFor="fee-rule-minimum">Biaya minimum</FormLabel>
          <FormInput
            id="fee-rule-minimum"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={minimumFeeAmount}
            onChange={(event) => setMinimumFeeAmount(event.target.value)}
          />
          <FormHelp>Kosongkan bila tidak ada batas bawah.</FormHelp>
        </FormField>

        <FormField>
          <FormLabel htmlFor="fee-rule-maximum">Biaya maksimum</FormLabel>
          <FormInput
            id="fee-rule-maximum"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={maximumFeeAmount}
            onChange={(event) => setMaximumFeeAmount(event.target.value)}
          />
          <FormHelp>Kosongkan bila tidak ada batas atas.</FormHelp>
        </FormField>

        <FormField>
          <FormLabel htmlFor="fee-rule-effective-from" required>
            Berlaku mulai
          </FormLabel>
          <FormInput
            id="fee-rule-effective-from"
            type="datetime-local"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            required
          />
        </FormField>

        <FormField>
          <FormLabel htmlFor="fee-rule-effective-to">Berlaku sampai</FormLabel>
          <FormInput
            id="fee-rule-effective-to"
            type="datetime-local"
            value={effectiveTo}
            onChange={(event) => setEffectiveTo(event.target.value)}
          />
          <FormHelp>Kosongkan untuk aturan tanpa batas akhir.</FormHelp>
        </FormField>
      </div>

      {preview?.rejected === true && (
        <Feedback tone="warning">
          Tarif ini mengambil seluruh pembayaran. Institusi tidak menerima apa pun dari penjualannya
          sendiri, jadi aturan ini akan ditolak saat disimpan.
        </Feedback>
      )}

      {preview?.rejected === false && (
        <Feedback tone="info">
          Pada penjualan {formatMinorUnits(PREVIEW_GROSS_AMOUNT, currency)}: platform menerima{" "}
          {formatMinorUnits(preview.fee, currency)}, institusi menerima{" "}
          {formatMinorUnits(preview.net, currency)}.
        </Feedback>
      )}

      <FormActionBar>
        <IconButton
          icon="arrow-left"
          label="Kembali ke Platform Operations"
          onClick={() => router.push("/admin")}
        />
        <div className="form-action-bar-end">
          <Button type="submit" loading={saving} leadingIcon={<Icon name="save" />}>
            Simpan
          </Button>
        </div>
      </FormActionBar>
    </form>
  );
}
