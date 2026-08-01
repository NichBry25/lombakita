import { describe, expect, it } from "vitest";
import { getMissingCompetitionPublishFields } from "./competition-publish-readiness";

const completeForm = () => ({
  title: "Lomba Inovasi",
  description: "Deskripsi kompetisi",
  category: "hackathon",
  mode: "individual",
  registrationStartAt: "2026-08-01T09:00",
  registrationEndAt: "2026-08-10T09:00",
  eventStartAt: "2026-08-15T09:00",
  eventEndAt: "2026-08-16T17:00",
  resultAnnouncementAt: "2026-08-20T09:00",
  participantConfirmationAt: "2026-08-12T09:00",
});

describe("getMissingCompetitionPublishFields", () => {
  it("allows posting when every required editor field is available", () => {
    expect(getMissingCompetitionPublishFields(completeForm())).toEqual([]);
  });

  it("reports every requested schedule and participant-confirmation field", () => {
    const missing = getMissingCompetitionPublishFields({
      ...completeForm(),
      registrationStartAt: "",
      registrationEndAt: "",
      eventStartAt: "",
      eventEndAt: "",
      resultAnnouncementAt: "",
      participantConfirmationAt: "",
    });

    expect(missing).toEqual([
      "Pendaftaran mulai",
      "Pendaftaran berakhir",
      "Acara mulai",
      "Acara berakhir",
      "Pengumuman hasil",
      "Konfirmasi peserta",
    ]);
  });

  it("treats whitespace-only title and description as missing", () => {
    const missing = getMissingCompetitionPublishFields({
      ...completeForm(),
      title: " ",
      description: "\n",
    });

    expect(missing).toEqual(["Judul", "Deskripsi"]);
  });
});
