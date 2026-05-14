import Link from "next/link";
import { SignupForm } from "@/components/auth/signup-form";
import { isEmailAuthConfigured } from "@/server/auth/auth.config";
import { isSignupRole } from "@/server/auth/credentials-auth";

// Rollback Step 1.3 — CCR-03 / DEC-0037 / DEC-0058.
// Bare /auth/signup renders the role-picker. /auth/signup?as=candidate and
// /auth/signup?as=recruiter render the corresponding signup form. An unknown ?as= value falls
// back to the role-picker (server-side declaration is the real gate; URL is the UX surface).
export default async function SignupPage(props: { searchParams?: Promise<{ as?: string }> }) {
  const searchParams = await props.searchParams;
  const asParam = searchParams?.as;

  if (asParam && isSignupRole(asParam)) {
    return <SignupForm signupRole={asParam} verificationEnabled={isEmailAuthConfigured} />;
  }

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "3rem 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>Pilih peran Anda</h1>
      <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#52525b" }}>
        Setiap akun bisa memiliki dua peran (kandidat dan recruiter), tetapi setidaknya satu peran
        harus diverifikasi saat pendaftaran. Anda dapat memverifikasi peran kedua nanti.
      </p>

      <div
        style={{
          marginTop: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        <Link
          href="/auth/signup?as=candidate"
          style={{
            display: "block",
            padding: "1rem",
            border: "1px solid #d4d4d8",
            borderRadius: 8,
            textDecoration: "none",
            color: "#18181b",
          }}
        >
          <strong>Daftar sebagai Kandidat</strong>
          <p style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: "#52525b" }}>
            Untuk mahasiswa atau lulusan yang mencari kompetisi, beasiswa, magang, dan peluang lain.
          </p>
        </Link>

        <Link
          href="/auth/signup?as=recruiter"
          style={{
            display: "block",
            padding: "1rem",
            border: "1px solid #d4d4d8",
            borderRadius: 8,
            textDecoration: "none",
            color: "#18181b",
          }}
        >
          <strong>Daftar sebagai Recruiter</strong>
          <p style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: "#52525b" }}>
            Untuk pewakilan institusi, kampus, atau organisasi yang ingin menerbitkan dan mengelola
            peluang.
          </p>
        </Link>
      </div>

      {asParam && !isSignupRole(asParam) ? (
        <p role="alert" style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#b91c1c" }}>
          Peran “{asParam}” tidak dikenali. Silakan pilih salah satu opsi di atas.
        </p>
      ) : null}

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#71717a" }}>
        Sudah punya akun?{" "}
        <Link href="/auth/sign-in" style={{ textDecoration: "underline" }}>
          Login di sini
        </Link>
        .
      </p>
    </main>
  );
}
