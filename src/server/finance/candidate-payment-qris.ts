import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/candidate-payment-qris");

import { logger } from "@/lib/logger";
import { assertQrisKeyBelongsToInstitution } from "@/server/institutions/payment-instructions-service";
import { generatePresignedGetUrl, isR2Available } from "@/server/storage/r2.client";

// Turns the organiser's stored QRIS key into a link the payer's browser can load. Total: every
// failure becomes "unavailable", because the candidate payment view feeds the proof routes and a
// payer who has already sent money must still be able to record the proof.

const QRIS_LINK_LIFETIME_SECONDS = 3600;

// A QRIS key has no extension and the upload stores no type, so no stored value can be trusted.
// One fixed image type stops the response being rendered as anything else, and an <img> decodes
// PNG, JPEG and WEBP by their bytes.
const QRIS_RESPONSE_CONTENT_TYPE = "image/png";
const QRIS_RESPONSE_CONTENT_DISPOSITION = 'inline; filename="qris.png"';

export type QrisImageLink = { kind: "shown"; url: string } | { kind: "unavailable" };

const UNAVAILABLE: QrisImageLink = { kind: "unavailable" };

export const signQrisImageLink = async (
  qrisR2Key: string,
  receivingInstitutionId: string,
): Promise<QrisImageLink> => {
  if (!isR2Available()) {
    return UNAVAILABLE;
  }

  try {
    assertQrisKeyBelongsToInstitution(qrisR2Key, receivingInstitutionId);
    const url = await generatePresignedGetUrl(qrisR2Key, QRIS_LINK_LIFETIME_SECONDS, {
      responseContentType: QRIS_RESPONSE_CONTENT_TYPE,
      responseContentDisposition: QRIS_RESPONSE_CONTENT_DISPOSITION,
    });
    return { kind: "shown", url };
  } catch (error) {
    logger.warn("candidate.payment.qris-link.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return UNAVAILABLE;
  }
};
