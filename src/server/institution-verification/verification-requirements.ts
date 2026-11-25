import type { InstitutionType } from "@/server/db/schema";

// Exhaustive mapping of institution type to the document types required for verification.
// document_type values are the canonical string keys stored on institution_verification_documents.
// Labels are Indonesian, shown in forms and ops review surfaces.

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  ktp: "KTP (Kartu Tanda Penduduk)",
  npwp: "NPWP (Nomor Pokok Wajib Pajak)",
  nib: "NIB (Nomor Induk Berusaha)",
  akta_pendirian: "Akta pendirian",
  sk_kemenkumham: "SK Kemenkumham",
  sk_pendirian: "SK pendirian",
  surat_keterangan_organisasi: "Surat keterangan organisasi",
  ktm: "KTM (Kartu Tanda Mahasiswa)",
};

// `personal` carries no documents: a personal institution is its owner, and the owner is vetted by
// host trust. createVerificationSubmission refuses a personal
// institution outright, so this entry exists only to keep the map exhaustive over InstitutionType.
export const REQUIRED_DOCUMENTS_BY_TYPE: Record<InstitutionType, readonly string[]> = {
  personal: [],
  company: ["npwp", "nib"],
  foundation: ["npwp", "akta_pendirian", "sk_kemenkumham"],
  university: ["sk_pendirian"],
  campus_organization: ["surat_keterangan_organisasi", "ktm"],
};

export const getRequiredDocumentsForType = (type: InstitutionType): readonly string[] =>
  REQUIRED_DOCUMENTS_BY_TYPE[type];

// Returns the set of document types missing from the submitted list.
// An empty set means all required documents are present.
export const getMissingDocuments = (
  targetType: InstitutionType,
  submittedDocumentTypes: string[],
): string[] => {
  const required = getRequiredDocumentsForType(targetType);
  const submitted = new Set(submittedDocumentTypes);
  return required.filter((d) => !submitted.has(d));
};

// Returns true when all required documents for the target type are present.
export const validateSubmissionDocuments = (
  targetType: InstitutionType,
  submittedDocumentTypes: string[],
): boolean => getMissingDocuments(targetType, submittedDocumentTypes).length === 0;

// Known personal-provider email domains. Used to derive the email_domain_flag for university
// and campus_organization submissions: true = institutional domain, false = personal provider.
// The host trust rules read the same set.
export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.id",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "outlook.co.id",
  "hotmail.com",
  "hotmail.co.id",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "protonmail.ch",
  "proton.me",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "tutanota.com",
  "tutanota.de",
  "tuta.io",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "fastmail.com",
  "hey.com",
  "naver.com",
  "rediffmail.com",
]);

// Derives the email_domain_flag for university/campus_organization submissions.
// Returns null for all other institution types (flag is not applicable).
// true = institutional domain, false = known personal-provider domain.
export const deriveEmailDomainFlag = (
  targetType: InstitutionType,
  email: string,
): boolean | null => {
  if (targetType !== "university" && targetType !== "campus_organization") return null;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  return !PERSONAL_EMAIL_DOMAINS.has(domain);
};
