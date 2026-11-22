import { AuthPageSkeleton } from "@/components/ui";

export default function MfaChallengeLoading() {
  return <AuthPageSkeleton label="Memuat verifikasi dua langkah" fields={1} />;
}
