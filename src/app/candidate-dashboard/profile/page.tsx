import { PageHeader } from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";
import { getCandidateProfile } from "@/server/candidate/candidate-profile-service";
import { CandidateProfileEditor } from "./candidate-profile-editor";

export default async function CandidateProfilePage() {
  const session = await requireRolePage("candidate", {
    callbackPath: "/candidate-dashboard/profile",
    missingRoleRedirect: "/auth/verify-role?as=candidate",
  });

  const profile = await getCandidateProfile(session.user.id);

  return (
    <main className="page-shell app-page candidate-dashboard">
      <PageHeader
        eyebrow="Ruang kandidat"
        title="Data kandidat"
        description="Perbarui data yang kamu isi saat mendaftar sebagai kandidat."
        backHref="/candidate-dashboard"
        backLabel="Dasbor"
      />

      {profile ? (
        <section className="content-section">
          <CandidateProfileEditor
            expectedUserId={session.user.id}
            initial={{
              fullName: profile.fullName,
              phoneNumber: profile.phoneNumber,
              occupation: profile.occupation,
              dateOfBirth: profile.dateOfBirth,
            }}
          />
        </section>
      ) : (
        <p className="feedback" data-tone="warning">
          Data kandidat Anda belum tersedia. Data ini biasanya diisi saat pendaftaran akun kandidat.
        </p>
      )}
    </main>
  );
}
