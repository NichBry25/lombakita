// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockWriteNotification, mockSendInstitutionTickNoticeEmail } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockWriteNotification: vi.fn(),
  mockSendInstitutionTickNoticeEmail: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/notifications/notification-service", () => ({
  writeNotification: mockWriteNotification,
}));
vi.mock("@/server/notifications/notification-email", () => ({
  sendInstitutionTickNoticeEmail: mockSendInstitutionTickNoticeEmail,
}));

import { absoluteSiteUrl } from "@/config/site-url";
import { formatWib } from "@/lib/dates/date-format";
import type { InstitutionTickNoticeKind } from "@/server/async/contracts";
import {
  processInstitutionTickNoticeJob,
  type InstitutionTickNoticeJob,
} from "./institution-tick-notice";

const WORKSPACE_ROW = {
  displayName: "Ruang Kerja Contoh",
  institutionType: "company",
  slug: "ruang-kerja-contoh",
  verificationStatus: "verified",
  tickPath: "domain",
  dueDateEqualsPayload: true,
};

const OWNER_ROWS = [
  { id: "u_1", email: "satu@seed.lombakita.local", username: "satu" },
  { id: "u_2", email: "dua@seed.lombakita.local", username: "dua" },
];

// A select that serves one result per call, in call order. The job awaits the owner read after
// orderBy and the workspace read after limit, so the chain answers at either end.
const makeSequencedSelect = (reads: unknown[][]) => {
  let call = 0;
  return vi.fn(() => {
    const rows = reads[call++] ?? [];
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "innerJoin", "where", "orderBy"]) chain[step] = () => chain;
    chain.limit = () => Promise.resolve(rows);
    chain.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  });
};

const mockUpdateData = vi.fn(async (_data: unknown) => undefined);

const noticeJob = (data: Record<string, unknown>): InstitutionTickNoticeJob =>
  ({ id: "job_t", data, updateData: mockUpdateData }) as unknown as InstitutionTickNoticeJob;

const DUE_AT = "2026-12-31T00:00:00.000000Z";

describe("processInstitutionTickNoticeJob", () => {
  afterEach(() => vi.clearAllMocks());

  it("rethrows an email failure after every inbox row is written", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[WORKSPACE_ROW], OWNER_ROWS]) });
    mockWriteNotification.mockResolvedValue(undefined);
    mockSendInstitutionTickNoticeEmail.mockRejectedValueOnce(new Error("smtp down"));

    await expect(
      processInstitutionTickNoticeJob(
        noticeJob({ institutionId: "inst_1", kind: "tick_granted", epoch: 1 }),
      ),
    ).rejects.toThrow("smtp down");

    expect(mockWriteNotification).toHaveBeenCalledTimes(2);
    const lastInboxOrder = Math.max(...mockWriteNotification.mock.invocationCallOrder);
    const firstEmailOrder = Math.min(
      ...mockSendInstitutionTickNoticeEmail.mock.invocationCallOrder,
    );
    expect(lastInboxOrder).toBeLessThan(firstEmailOrder);
  });

  it("writes the inbox rows once and records it before the first email", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[WORKSPACE_ROW], OWNER_ROWS]) });
    mockWriteNotification.mockResolvedValue(undefined);
    mockSendInstitutionTickNoticeEmail.mockRejectedValueOnce(new Error("smtp down"));

    await expect(
      processInstitutionTickNoticeJob(
        noticeJob({ institutionId: "inst_1", kind: "tick_granted", epoch: 1 }),
      ),
    ).rejects.toThrow("smtp down");

    expect(mockWriteNotification).toHaveBeenCalledTimes(2);
    expect(mockUpdateData).toHaveBeenCalledTimes(1);
    expect(mockUpdateData).toHaveBeenCalledWith({
      institutionId: "inst_1",
      kind: "tick_granted",
      epoch: 1,
      inboxWritten: true,
    });
    const lastInboxOrder = Math.max(...mockWriteNotification.mock.invocationCallOrder);
    const recordOrder = mockUpdateData.mock.invocationCallOrder[0]!;
    const firstEmailOrder = Math.min(
      ...mockSendInstitutionTickNoticeEmail.mock.invocationCallOrder,
    );
    expect(lastInboxOrder).toBeLessThan(recordOrder);
    expect(recordOrder).toBeLessThan(firstEmailOrder);
  });

  it("writes no inbox row again on a retry after a failed email", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[WORKSPACE_ROW], OWNER_ROWS]) });
    mockWriteNotification.mockResolvedValue(undefined);
    mockSendInstitutionTickNoticeEmail.mockResolvedValue(undefined);

    await expect(
      processInstitutionTickNoticeJob(
        noticeJob({ institutionId: "inst_1", kind: "tick_granted", epoch: 1, inboxWritten: true }),
      ),
    ).resolves.toBeUndefined();

    expect(mockWriteNotification).not.toHaveBeenCalled();
    expect(mockSendInstitutionTickNoticeEmail).toHaveBeenCalledTimes(2);
    expect(mockUpdateData).not.toHaveBeenCalled();
  });

  it("writes the words of every notice kind", async () => {
    const name = WORKSPACE_ROW.displayName;
    const date = formatWib(DUE_AT, "longDate");
    const paidBlocked =
      "Kompetisi berbayar baru tidak dapat diterbitkan sampai centang didapat lagi.";
    const cases: Array<{
      kind: InstitutionTickNoticeKind;
      payload: Record<string, unknown>;
      title: string;
      body: string;
    }> = [
      {
        kind: "tick_granted",
        payload: {},
        title: "Ruang kerja Anda terverifikasi",
        body: `${name} kini memiliki centang terverifikasi.`,
      },
      {
        kind: "tick_request_turned_down",
        payload: { reason: "Foto dokumen buram" },
        title: "Permintaan centang belum disetujui",
        body: "Catatan staf: Foto dokumen buram. Perbaiki lalu kirim lagi.",
      },
      {
        kind: "tick_request_turned_down",
        payload: {},
        title: "Permintaan centang belum disetujui",
        body: "Periksa lagi syarat jalur yang Anda pilih lalu kirim lagi.",
      },
      {
        kind: "tick_revoked",
        payload: { reason: "Pengaduan dari institusi resmi." },
        title: "Centang ruang kerja dicabut",
        body: `Alasan: Pengaduan dari institusi resmi. ${paidBlocked}`,
      },
      {
        kind: "tick_removed_name_proof",
        payload: { dueAt: DUE_AT },
        title: "Centang ruang kerja dicabut",
        body: `Bukti nama ${name} tidak kami terima dalam 28 hari. ${paidBlocked}`,
      },
      {
        kind: "name_checked",
        payload: {},
        title: "Nama ruang kerja sudah diperiksa",
        body: `Kompetisi berbayar ${name} kini dapat diterbitkan. Buka drafnya lalu tekan Terbitkan.`,
      },
      {
        kind: "name_proof_requested",
        payload: { reason: "Kirim akta pendirian", dueAt: DUE_AT },
        title: "Buktikan nama ruang kerja Anda",
        body: `Staf meminta bukti bahwa ${name} berhak memakai nama ini. Catatan staf: Kirim akta pendirian. Kirim dokumen sebagai bukti sebelum ${date}. Tanpa bukti, centang dicabut otomatis.`,
      },
      {
        kind: "name_proof_reminder",
        payload: { dueAt: DUE_AT },
        title: "Sisa 7 hari untuk bukti nama",
        body: `Kirim dokumen sebagai bukti nama ${name} sebelum ${date}. Tanpa bukti, centang dicabut otomatis.`,
      },
      {
        kind: "renamed_by_staff",
        payload: { reason: "Nama sesuai akta" },
        title: "Nama ruang kerja diubah staf",
        body: `Nama: ${name}. Alamat: ${absoluteSiteUrl(`/institution/${WORKSPACE_ROW.slug}`)}. Alasan: Nama sesuai akta.`,
      },
    ];

    for (const { kind, payload, title, body } of cases) {
      vi.clearAllMocks();
      mockGetDb.mockReturnValue({
        select: makeSequencedSelect([[WORKSPACE_ROW], [OWNER_ROWS[0]]]),
      });
      mockWriteNotification.mockResolvedValue(undefined);
      mockSendInstitutionTickNoticeEmail.mockResolvedValue(undefined);

      await processInstitutionTickNoticeJob(
        noticeJob({ institutionId: "inst_1", kind, epoch: 1, ...payload }),
      );

      expect(mockWriteNotification).toHaveBeenCalledWith(
        expect.anything(),
        "u_1",
        "institution_tick_notice",
        title,
        body,
      );
      expect(mockSendInstitutionTickNoticeEmail).toHaveBeenCalledWith({
        toEmail: "satu@seed.lombakita.local",
        recipientId: "u_1",
        title,
        body,
        institutionSlug: "ruang-kerja-contoh",
      });
    }
  });
});
