// Pedoman kompetisi. A staff turn-down of a host check stores the code, so a code never changes.
// The sentences are a draft whose wording is still to be approved on the built page.
export const COMPETITION_GUIDELINE_CODES = [
  "kontak-nyata",
  "hadiah-jujur",
  "biaya-jelas",
  "bukan-undian",
  "tanpa-kata-sandi",
  "data-secukupnya",
  "bukan-skema-rekrutmen",
  "tanpa-judi",
  "konten-pantas",
  "identitas-benar",
] as const;

export type CompetitionGuidelineCode = (typeof COMPETITION_GUIDELINE_CODES)[number];

export type CompetitionGuideline = { code: CompetitionGuidelineCode; text: string };

export const COMPETITION_GUIDELINES: readonly CompetitionGuideline[] = [
  {
    code: "kontak-nyata",
    text: "Penyelenggara mencantumkan kontak yang benar-benar bisa dihubungi peserta.",
  },
  {
    code: "hadiah-jujur",
    text: "Hadiah, sertifikat, dan manfaat ditulis sesuai yang benar-benar akan diberikan.",
  },
  {
    code: "biaya-jelas",
    text: "Biaya pendaftaran, jika ada, ditulis jelas sejak awal. Tidak ada biaya tambahan yang baru muncul setelah peserta mendaftar.",
  },
  {
    code: "bukan-undian",
    text: "Kompetisi dinilai dari karya atau kemampuan peserta, bukan dari undian berbayar.",
  },
  {
    code: "tanpa-kata-sandi",
    text: "Penyelenggara tidak meminta kata sandi, kode OTP, PIN, atau data rekening selain untuk pembayaran yang tertulis di halaman kompetisi.",
  },
  {
    code: "data-secukupnya",
    text: "Dokumen dan data pribadi diminta hanya sejauh dibutuhkan untuk kompetisi.",
  },
  {
    code: "bukan-skema-rekrutmen",
    text: "Tidak ada skema berantai, arisan, atau kewajiban merekrut peserta lain demi hadiah.",
  },
  {
    code: "tanpa-judi",
    text: "Tidak ada taruhan atau perjudian dalam bentuk apa pun.",
  },
  {
    code: "konten-pantas",
    text: "Tidak ada konten yang mengandung kebencian, pelecehan, kekerasan, atau pornografi.",
  },
  {
    code: "identitas-benar",
    text: "Penyelenggara tidak mengaku sebagai lembaga atau pihak lain tanpa izin.",
  },
];

export const isCompetitionGuidelineCode = (value: string): value is CompetitionGuidelineCode =>
  (COMPETITION_GUIDELINE_CODES as readonly string[]).includes(value);

// Null for a code the list does not hold.
export const competitionGuidelineTextOf = (code: string): string | null => {
  const guideline = COMPETITION_GUIDELINES.find((entry) => entry.code === code);
  return guideline?.text ?? null;
};
