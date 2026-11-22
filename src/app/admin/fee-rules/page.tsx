import {
  EmptyState,
  PageHeader,
  Table,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";
import { listFeeRules } from "@/server/finance/fee-rule-service";
import { FeeRuleForm } from "./fee-rule-form";
import { formatBasisPoints, formatMinorUnits } from "./fee-rule-display";
import { requireRolePage } from "@/server/auth/page-guard";

const RULE_COLUMNS: readonly TableColumn[] = [
  { key: "scope", header: "Cakupan", kind: "name" },
  { key: "rate", header: "Tarif", kind: "number" },
  { key: "flatAmount", header: "Biaya tetap", kind: "number" },
  { key: "minimum", header: "Minimum", kind: "number" },
  { key: "maximum", header: "Maksimum", kind: "number" },
  { key: "from", header: "Mulai", kind: "date" },
  { key: "to", header: "Sampai", kind: "date" },
];

export default async function AdminFeeRulesPage() {
  await requireRolePage("platform_ops", { callbackPath: "/admin/fee-rules" });

  const rules = await listFeeRules();

  const ruleRows: TableRowData[] = rules.map((rule) => ({
    key: rule.id,
    cells: {
      scope: rule.institutionId === null ? "Global" : (rule.institutionSlug ?? rule.institutionId),
      rate: formatBasisPoints(rule.basisPoints),
      flatAmount: formatMinorUnits(rule.flatAmount, rule.currency),
      minimum:
        rule.minimumFeeAmount === null
          ? null
          : formatMinorUnits(rule.minimumFeeAmount, rule.currency),
      maximum:
        rule.maximumFeeAmount === null
          ? null
          : formatMinorUnits(rule.maximumFeeAmount, rule.currency),
      from: <LocalDate value={rule.effectiveFrom} format="shortDate" />,
      to:
        rule.effectiveTo === null ? null : (
          <LocalDate value={rule.effectiveTo} format="shortDate" />
        ),
    },
  }));

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Aturan biaya platform"
        description="Tarif komisi platform, berlaku per tanggal. Aturan tidak pernah diubah. Tarif baru dicatat sebagai aturan baru yang menggantikan aturan lama sejak tanggal berlakunya."
        titleMark={
          rules.length > 0 ? (
            <span className="status-badge data-text">{rules.length} aturan</span>
          ) : null
        }
      />

      <section className="admin-section" aria-labelledby="fee-rule-create-heading">
        <h2 id="fee-rule-create-heading" className="section-heading">
          Buat aturan baru
        </h2>
        <FeeRuleForm />
      </section>

      <section className="admin-section" aria-labelledby="fee-rule-list-heading">
        <h2 id="fee-rule-list-heading" className="section-heading">
          Aturan tersimpan
        </h2>

        {rules.length === 0 && (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Belum ada aturan biaya"
            description="Pendaftaran berbayar tidak bisa diaktifkan sampai satu aturan berlaku."
          />
        )}

        {rules.length > 0 && (
          <Table label="Aturan tersimpan" columns={RULE_COLUMNS} rows={ruleRows} />
        )}
      </section>
    </main>
  );
}
