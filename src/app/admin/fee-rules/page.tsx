import { EmptyState, PageHeader } from "@/components/ui";
import { listFeeRules } from "@/server/finance/fee-rule-service";
import { FeeRuleForm } from "./fee-rule-form";
import { formatBasisPoints, formatEffectiveDate, formatMinorUnits } from "./fee-rule-display";

// Protected by /admin/layout.tsx (platform_ops only), and requireRolePage applies the operational
// MFA challenge, so this surface is gated on the same choke point as every other /admin page.
export default async function AdminFeeRulesPage() {
  const rules = await listFeeRules();

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Aturan biaya platform"
        description="Tarif komisi platform, berlaku per tanggal. Aturan tidak pernah diubah. Tarif baru dicatat sebagai aturan baru yang menggantikan aturan lama sejak tanggal berlakunya."
        actions={<span className="status-badge data-text">{rules.length} aturan</span>}
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
            icon="settings"
            title="Belum ada aturan biaya."
            description="Pendaftaran berbayar tidak bisa diaktifkan sampai satu aturan berlaku."
          />
        )}

        {rules.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cakupan</th>
                  <th>Tarif</th>
                  <th>Biaya tetap</th>
                  <th>Minimum</th>
                  <th>Maksimum</th>
                  <th>Mulai</th>
                  <th>Sampai</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      {rule.institutionId === null ? (
                        <span className="status-badge">Global</span>
                      ) : (
                        <span className="data-text">
                          {rule.institutionSlug ?? rule.institutionId}
                        </span>
                      )}
                    </td>
                    <td className="data-text">{formatBasisPoints(rule.basisPoints)}</td>
                    <td className="data-text">
                      {formatMinorUnits(rule.flatAmount, rule.currency)}
                    </td>
                    <td className="data-text">
                      {rule.minimumFeeAmount === null
                        ? "—"
                        : formatMinorUnits(rule.minimumFeeAmount, rule.currency)}
                    </td>
                    <td className="data-text">
                      {rule.maximumFeeAmount === null
                        ? "—"
                        : formatMinorUnits(rule.maximumFeeAmount, rule.currency)}
                    </td>
                    <td className="data-text">{formatEffectiveDate(rule.effectiveFrom)}</td>
                    <td className="data-text">
                      {rule.effectiveTo === null ? "—" : formatEffectiveDate(rule.effectiveTo)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
