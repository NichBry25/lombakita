import { AuthPageSkeleton } from "@/components/ui";

export default function MfaEnrollLoading() {
  return <AuthPageSkeleton label="Memuat pengaktifan verifikasi dua langkah" fields={8} />;
}
