import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/notifications/notification-email");

import { Resend } from "resend";
import { asSentence } from "@/lib/finance/payment-display";
import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { resolveEmailDelivery, type EmailDelivery } from "@/server/email/delivery";

// A deadline carried on a job payload travels as an ISO string. Rendered in Indonesian long form
// to match the registration-confirmation email, and with the time included because a document
// deadline is acted on the same day it falls.
const formatEmailDate = (isoDate: string): string =>
  new Date(isoDate).toLocaleString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

const resolveNotificationDelivery = (kind: string, toEmail: string): EmailDelivery | null => {
  return resolveEmailDelivery({ kind, to: toEmail });
};

export const sendRegistrationConfirmedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  registrationType: "individual" | "team";
  registeredAt: Date;
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("registration_confirmed", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;
  const typeLabel = options.registrationType === "team" ? "Tim" : "Individu";
  const dateFormatted = options.registeredAt.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Pendaftaran kamu berhasil — ${options.competitionTitle}`,
    text: [
      `Pendaftaran kamu untuk kompetisi "${options.competitionTitle}" telah berhasil.`,
      "",
      `Jenis pendaftaran: ${typeLabel}`,
      `Tanggal daftar: ${dateFormatted}`,
      "",
      `Pantau perkembangan kompetisi kamu di ${resolveBaseUrl()}.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend registration confirmed email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "registration.confirmed",
    recipientId: options.recipientId,
  });
};

export const sendRegistrationCancelledEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  registrationType: "individual" | "team";
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("registration_cancelled", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;
  const typeLabel = options.registrationType === "team" ? "tim" : "individu";

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Pendaftaran kamu dibatalkan — ${options.competitionTitle}`,
    text: [
      `Pendaftaran ${typeLabel} kamu untuk kompetisi "${options.competitionTitle}" telah dibatalkan.`,
      "",
      `Kunjungi ${resolveBaseUrl()} untuk melihat kompetisi lainnya.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend registration cancelled email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "registration.cancelled",
    recipientId: options.recipientId,
  });
};

export const sendSubmissionFinalizedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  finalizedAt: Date;
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("submission_finalized", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;
  const dateFormatted = options.finalizedAt.toLocaleString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Pengiriman kamu telah dikunci — ${options.competitionTitle}`,
    text: [
      `Pengiriman kamu untuk kompetisi "${options.competitionTitle}" telah dikunci pada ${dateFormatted}.`,
      "",
      "Pengiriman yang telah dikunci tidak dapat diubah.",
      "",
      `Pantau perkembangan kompetisi kamu di ${resolveBaseUrl()}.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend submission finalized email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "submission.finalized",
    recipientId: options.recipientId,
  });
};

export const sendResultPublishedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  displayName: string | null;
  competitionTitle: string;
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("result_published", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;
  const greeting = options.displayName ? `Hai ${options.displayName},` : "Hai,";

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Hasil kompetisi telah diumumkan — ${options.competitionTitle}`,
    text: [
      greeting,
      "",
      `Hasil kompetisi "${options.competitionTitle}" telah diumumkan.`,
      "",
      `Cek hasilmu di ${resolveBaseUrl()}.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend result published email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "result.published",
    recipientId: options.recipientId,
  });
};

// Competition lifecycle emails. The copy lists broad change categories (schedule /
// fees / rules) and never the old/new field values; the listing page is the source of truth.
// Callers (the competition-edited/cancelled workers) invoke these fire-and-forget and warn-log on
// failure rather than rethrowing.
export const sendCompetitionEditedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  changeCategories?: string[];
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("competition_edited", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;

  const categories = options.changeCategories ?? [];
  const changeLine =
    categories.length > 0
      ? `Bagian yang berubah: ${categories.join(", ")}.`
      : "Beberapa detail kompetisi diperbarui.";

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Kompetisi diperbarui — ${options.competitionTitle}`,
    text: [
      `Kompetisi "${options.competitionTitle}" yang kamu daftarkan diperbarui oleh penyelenggara.`,
      "",
      changeLine,
      "",
      `Cek perubahannya di ${resolveBaseUrl()}.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend competition edited email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "competition.edited",
    recipientId: options.recipientId,
  });
};

export const sendCompetitionCancelledEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  cancellationReason?: string;
  /** Set only for a recipient who holds a priced payment (see the worker's payer scoping). */
  transferRefundNotice?: boolean;
  publicCompetition?: {
    institutionSlug: string;
    competitionSlug: string;
  };
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("competition_cancelled", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;
  const publicCompetitionUrl = options.publicCompetition
    ? `${resolveBaseUrl()}/competitions/${encodeURIComponent(
        options.publicCompetition.institutionSlug,
      )}/${encodeURIComponent(options.publicCompetition.competitionSlug)}`
    : null;

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Kompetisi dibatalkan — ${options.competitionTitle}`,
    text: [
      `Kompetisi "${options.competitionTitle}" yang kamu daftarkan telah dibatalkan oleh penyelenggara.`,
      ...(options.cancellationReason ? ["", `Alasan: ${options.cancellationReason}`] : []),
      // DEC-0130: the transfer went to the organiser's account and Lombakita never held it, so the
      // only honest thing this notice can do is say who has the money.
      ...(options.transferRefundNotice
        ? [
            "",
            "Jika kamu sudah melakukan transfer, dana tersebut ada pada rekening penyelenggara. Hubungi penyelenggara secara langsung untuk pengembaliannya. Lombakita tidak menampung dana peserta sehingga tidak dapat memprosesnya.",
          ]
        : []),
      "",
      publicCompetitionUrl
        ? `Lihat status kompetisi di ${publicCompetitionUrl}.`
        : `Lihat kompetisi lainnya di ${resolveBaseUrl()}.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend competition cancelled email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "competition.cancelled",
    recipientId: options.recipientId,
  });
};

export const sendRecruiterVerificationRejectedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  rejectionReason: string;
  resubmissionAllowed: boolean;
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("recruiter_verification_rejected", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;

  const nextStep = options.resubmissionAllowed
    ? "Perbarui data dan dokumen Anda di dasbor rekruter, lalu ajukan ulang."
    : "Akun Anda tidak dapat mengirim permohonan baru. Hubungi tim dukungan jika Anda merasa keputusan ini keliru.";

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: "Permohonan Rekruter Terpercaya ditolak",
    text: [
      "Permohonan verifikasi Rekruter Terpercaya Anda ditolak.",
      "",
      `Alasan: ${options.rejectionReason}`,
      "",
      nextStep,
      "",
      `Buka dasbor Anda di ${resolveBaseUrl()}/recruiter-dashboard.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(
      `Resend recruiter verification rejected email dispatch failed: ${error.message}`,
    );
  }

  logger.info("notification.sent", {
    event: "recruiter.verification.rejected",
    recipientId: options.recipientId,
  });
};

// A participant is asked for a document. The email carries the ask, the deadline and where to go —
// enough to act on without signing in first to find out what is wanted.
export const sendRegistrationDocumentRequestedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  institutionName: string;
  title: string;
  instructions: string | null;
  dueAtIso: string;
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("registration_document_requested", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Dokumen diminta untuk ${options.competitionTitle}`,
    text: [
      `${options.institutionName} meminta dokumen untuk pendaftaran Anda di ${options.competitionTitle}.`,
      "",
      `Dokumen yang diminta: ${options.title}`,
      ...(options.instructions ? ["", options.instructions] : []),
      "",
      `Batas waktu: ${formatEmailDate(options.dueAtIso)}`,
      "",
      "Pendaftaran Anda tetap aktif selama proses ini.",
      "",
      `Unggah dokumen Anda di ${resolveBaseUrl()}/candidate-dashboard/registrations.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend document requested email dispatch failed: ${error.message}`);
  }
};

// The verdict on a requested document. A rejection that reopens the request says so and carries the
// new deadline, so the recipient never has to guess whether they may try again.
export const sendRegistrationDocumentReviewedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  title: string;
  outcome: "accepted" | "rejected" | "revision_requested";
  reviewNote: string | null;
  dueAtIso: string | null;
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("registration_document_reviewed", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;

  const subject =
    options.outcome === "accepted"
      ? `Dokumen diterima untuk ${options.competitionTitle}`
      : options.outcome === "revision_requested"
        ? `Dokumen perlu diunggah ulang untuk ${options.competitionTitle}`
        : `Dokumen ditolak untuk ${options.competitionTitle}`;

  const body =
    options.outcome === "accepted"
      ? [`Dokumen "${options.title}" Anda telah diterima.`]
      : options.outcome === "revision_requested"
        ? [
            `Dokumen "${options.title}" Anda belum dapat diterima dan perlu diunggah ulang.`,
            ...(options.reviewNote ? ["", `Alasan: ${options.reviewNote}`] : []),
            ...(options.dueAtIso
              ? ["", `Batas waktu baru: ${formatEmailDate(options.dueAtIso)}`]
              : []),
          ]
        : [
            `Dokumen "${options.title}" Anda ditolak.`,
            ...(options.reviewNote ? ["", `Alasan: ${options.reviewNote}`] : []),
          ];

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject,
    text: [
      ...body,
      "",
      `Buka pendaftaran Anda di ${resolveBaseUrl()}/candidate-dashboard/registrations.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend document reviewed email dispatch failed: ${error.message}`);
  }
};

/**
 * The organiser's copy of "someone says they paid".
 *
 * Deliberately does not assert that money arrived, because the platform never sees it (DEC-0130).
 * It says what the candidate CLAIMS and asks for a decision, because the organiser's bank
 * statement is the only record that can settle it.
 */
export const sendPaymentProofSubmittedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  institutionSlug: string;
  competitionSlug: string;
  payerDisplayName: string;
  amount: string;
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("payment_proof_submitted", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;

  const reviewQueueUrl =
    `${resolveBaseUrl()}/institution/${encodeURIComponent(options.institutionSlug)}` +
    `/competitions/${encodeURIComponent(options.competitionSlug)}/payments`;

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Bukti transfer baru untuk ${options.competitionTitle}`,
    text: [
      `${options.payerDisplayName} mengirim bukti transfer sebesar ${options.amount} untuk ${options.competitionTitle}.`,
      "",
      "Cocokkan dengan mutasi rekening lembaga Anda sebelum memberi keputusan. Dana peserta masuk langsung ke rekening Anda, bukan ke Lombakita.",
      "",
      `Tinjau di ${reviewQueueUrl}.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend payment proof submitted email dispatch failed: ${error.message}`);
  }
};

type PaymentOutcomeKind = "verified" | "rejected" | "expired" | "voided";

/** One line per outcome. Separate from the body so the four arms are read once, not twice. */
const paymentOutcomeSubject = (outcome: PaymentOutcomeKind, competitionTitle: string): string => {
  if (outcome === "verified") return `Pembayaran diverifikasi untuk ${competitionTitle}`;
  if (outcome === "rejected") return `Bukti transfer ditolak untuk ${competitionTitle}`;
  if (outcome === "voided") return `Bukti transfer dibatalkan untuk ${competitionTitle}`;
  return `Pendaftaran dibatalkan otomatis untuk ${competitionTitle}`;
};

/**
 * The body lines for one outcome.
 *
 * Early returns rather than a ternary chain: four outcomes with three different actors is the point
 * at which a nested conditional stops showing which sentence belongs to which decision, and WHICH
 * ACTOR EACH ARM NAMES is the property that has to stay legible here.
 */
const paymentOutcomeBody = (options: {
  competitionTitle: string;
  outcome: PaymentOutcomeKind;
  rejectionReason: string | null;
  resubmissionAllowed: boolean | null;
  amount: string;
}): string[] => {
  const reasonLines = options.rejectionReason
    ? ["", `Alasan: ${asSentence(options.rejectionReason)}`]
    : [];

  if (options.outcome === "verified") {
    return [
      `Penyelenggara telah memverifikasi pembayaran sebesar ${options.amount} untuk ${options.competitionTitle}.`,
      "",
      "Pendaftaran Anda aktif. Tidak ada tindakan lain yang diperlukan.",
    ];
  }

  if (options.outcome === "rejected") {
    return [
      `Bukti transfer Anda untuk ${options.competitionTitle} ditolak oleh penyelenggara.`,
      ...reasonLines,
      "",
      options.resubmissionAllowed === false
        ? "Anda tidak dapat mengirim bukti baru. Hubungi penyelenggara sebelum batas waktu. Jika terlewat, pendaftaran dibatalkan secara otomatis."
        : "Unggah bukti transfer yang baru sebelum batas waktu pembayaran.",
    ];
  }

  if (options.outcome === "voided") {
    // Lombakita is named as the actor and the organiser is explicitly excluded. Resubmission is
    // stated unconditionally because the voided arm of the reopen CAS bypasses the organiser's bar.
    return [
      `Tim Lombakita membatalkan bukti transfer Anda untuk ${options.competitionTitle}. Pembatalan ini bukan keputusan penyelenggara.`,
      ...reasonLines,
      "",
      "Anda dapat mengirim bukti transfer baru sebelum batas waktu pembayaran.",
    ];
  }

  // No actor. The sentence names the deadline as the cause and says outright that nobody decided
  // this, so the recipient does not go looking for someone to appeal to.
  return [
    `Batas waktu pembayaran untuk ${options.competitionTitle} telah lewat, sehingga pendaftaran Anda dibatalkan secara otomatis.`,
    "",
    "Pembatalan ini tidak dilakukan oleh penyelenggara dan bukan atas permintaan Anda. Jika Anda sudah melakukan transfer, hubungi penyelenggara.",
  ];
};

/**
 * What became of the money, to a member of the payment group.
 *
 * THE EXPIRED ARM HAS NO AUTHOR AND MUST NOT SOUND LIKE IT DOES. Nobody rejected this candidate;
 * a deadline passed. Wording it as a decision would have them contact an organiser to appeal
 * something no organiser did.
 */
export const sendPaymentOutcomeEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  outcome: PaymentOutcomeKind;
  rejectionReason: string | null;
  resubmissionAllowed: boolean | null;
  amount: string;
}): Promise<void> => {
  const delivery = resolveNotificationDelivery("payment_outcome", options.toEmail);

  if (!delivery) {
    return;
  }

  const { apiKey, from } = delivery;

  const subject = paymentOutcomeSubject(options.outcome, options.competitionTitle);
  const body = paymentOutcomeBody(options);

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject,
    text: [
      ...body,
      "",
      `Buka pendaftaran Anda di ${resolveBaseUrl()}/candidate-dashboard/registrations.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend payment outcome email dispatch failed: ${error.message}`);
  }
};
