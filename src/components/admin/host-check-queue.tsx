"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Button,
  Card,
  DetailList,
  EmptyState,
  Feedback,
  FormError,
  FormField,
  FormLabel,
  FormTextareaWithLimit,
  SelectField,
  Skeleton,
} from "@/components/ui";
import { useModal, useModalTask, useToast, type ModalOutcome } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import {
  COMPETITION_GUIDELINES,
  competitionGuidelineTextOf,
} from "@/lib/competitions/competition-guidelines";
import { getCompetitionLocationLabel } from "@/lib/competitions/locations";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";
import {
  ORGANIZER_CONTACT_KIND_LABELS,
  toOrganizerContact,
  type OrganizerContactKind,
} from "@/lib/competitions/organizer-contact";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { formatRupiah } from "@/lib/finance/payment-display";

// One open host check as the queue route answers it. JSON carries the dates as ISO strings.
export type HostCheckQueueItem = {
  id: string;
  submittedAt: string;
  overdue: boolean;
  host: {
    userId: string;
    fullName: string;
    mobileNumber: string;
    email: string;
    trustRemovedAt: string | null;
    trustRemovalReason: string | null;
  };
  draft: {
    competitionId: string;
    title: string;
    description: string;
    category: string | null;
    mode: string | null;
    location: string | null;
    registrationStartAt: string | null;
    registrationEndAt: string | null;
    eventStartAt: string | null;
    eventEndAt: string | null;
    resultAnnouncementAt: string | null;
    feeAmount: number | null;
    feeCurrency: string | null;
    organizerContactKind: OrganizerContactKind | null;
    organizerContactValue: string | null;
    institutionName: string | null;
  };
  earlierTurnDowns: { reviewedAt: string | null; guidelineItem: string; note: string | null }[];
};

type HostCheckDraft = HostCheckQueueItem["draft"];

type EarlierTurnDown = HostCheckQueueItem["earlierTurnDowns"][number];

type QueueState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; items: HostCheckQueueItem[] };

type HostCheckDecisionBody =
  | { decision: "approve" }
  | { decision: "turn_down"; guidelineItem: string; note: string };

type HostCheckDecisionAnswer = {
  id: string;
  userId: string;
  status: "approved" | "rejected";
  published: boolean;
};

const QUEUE_URL = "/api/platform-ops/host-checks";

// The service caps a turn-down note at 1000 characters.
const TURN_DOWN_NOTE_MAX_LENGTH = 1000;

const TURN_DOWN_FORM_ID = "host-check-turn-down-form";

const APPROVE_BODY: HostCheckDecisionBody = { decision: "approve" };

const NOT_FILLED = "Belum diisi";
const FREE_LABEL = "Gratis";
const QUEUE_LOAD_FALLBACK = "Gagal memuat antrean pemeriksaan.";
const QUEUE_LOAD_NETWORK_MESSAGE = "Gagal memuat antrean karena gangguan koneksi.";
const APPROVE_FALLBACK = "Pemeriksaan gagal disetujui. Coba lagi.";
const TURN_DOWN_FALLBACK = "Pemeriksaan gagal ditolak. Coba lagi.";
const GUIDELINE_MISSING_MESSAGE = "Pilih pedoman yang tidak dipenuhi.";
const NOTE_MISSING_MESSAGE = "Isi catatan untuk penyelenggara.";
const APPROVED_PUBLISHED_MESSAGE =
  "Disetujui. Akun ini kini tepercaya dan kompetisinya sudah tayang.";
const APPROVED_NOT_PUBLISHED_MESSAGE =
  "Disetujui. Akun ini kini tepercaya, tetapi kompetisinya belum dapat tayang. Penyelenggara diminta menerbitkannya sendiri.";
const CLOSED_DRAFT_GONE_MESSAGE =
  "Draf ini sudah tidak tersedia, jadi pemeriksaan ditutup tanpa persetujuan.";
const TURNED_DOWN_MESSAGE = "Pemeriksaan ditolak dan keluar dari antrean.";

// Refusals of the decision route in the operator's words. Copied from the codes of the decision
// service and the operator actor, because those modules load the database client and this is a
// client component.
const HOST_CHECK_DECISION_ERROR_COPY: Partial<Record<string, string>> = {
  invalid_payload: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  host_check_not_found: "Pemeriksaan tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  host_check_already_decided:
    "Pemeriksaan ini sudah diputuskan. Muat ulang halaman untuk melihat antrean terbaru.",
  host_check_guideline_required: "Pilih pedoman yang tidak dipenuhi.",
  host_check_guideline_unknown:
    "Pedoman itu tidak ada dalam daftar. Muat ulang halaman lalu pilih lagi.",
  host_check_note_required: "Isi catatan untuk penyelenggara, paling banyak 1000 karakter.",
  host_check_target_not_host:
    "Akun ini tidak memegang peran penyelenggara, jadi tidak dapat disetujui. Tolak pemeriksaan ini untuk menutupnya.",
  account_deactivated: "Data akun ini sudah dihapus. Tindakan ini tidak tersedia.",
  operator_actor_not_found: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  operator_actor_not_platform_ops:
    "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  operator_actor_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
  operator_actor_is_target: "Anda tidak dapat memeriksa kompetisi akun Anda sendiri.",
};

const GUIDELINE_OPTIONS = COMPETITION_GUIDELINES.map(({ code, text }) => ({
  value: code,
  label: text,
}));

const queueStateOf = (items: HostCheckQueueItem[] | null): QueueState => {
  if (items === null) return { status: "failed" };
  return { status: "ready", items };
};

const decisionRefusalOf = async (response: Response, fallback: string): Promise<string> => {
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string };
  } | null;
  return errorMessageFor(payload?.error?.code, HOST_CHECK_DECISION_ERROR_COPY, fallback);
};

// A check whose draft was deleted or is no longer a draft closes without a judgment, so an
// approval of it answers status rejected.
const decisionSuccessMessageOf = (
  body: HostCheckDecisionBody,
  answer: HostCheckDecisionAnswer,
): string => {
  if (body.decision === "turn_down") return TURNED_DOWN_MESSAGE;
  if (answer.status === "rejected") return CLOSED_DRAFT_GONE_MESSAGE;
  return answer.published ? APPROVED_PUBLISHED_MESSAGE : APPROVED_NOT_PUBLISHED_MESSAGE;
};

const feeLabelOf = (draft: HostCheckDraft): string => {
  if (draft.feeAmount === null || !isPaidCompetition(draft.feeAmount)) return FREE_LABEL;
  return formatRupiah(draft.feeAmount, draft.feeCurrency ?? "IDR");
};

const contactLabelOf = (draft: HostCheckDraft): string => {
  const contact = toOrganizerContact(draft.organizerContactKind, draft.organizerContactValue);
  if (!contact) return NOT_FILLED;
  return `${ORGANIZER_CONTACT_KIND_LABELS[contact.kind]} ${contact.value}`;
};

function DraftDate({ value }: { value: string | null }) {
  if (value === null) return <>{NOT_FILLED}</>;
  return <LocalDate value={value} format="longDateTime" />;
}

const factRowsOf = (item: HostCheckQueueItem) => {
  const { host, draft } = item;
  return [
    { label: "Nama", value: host.fullName },
    { label: "Nomor ponsel", value: host.mobileNumber },
    { label: "Email akun", value: host.email },
    { label: "Dikirim", value: <LocalDate value={item.submittedAt} format="longDateTime" /> },
    { label: "Kategori", value: getCompetitionCategoryLabel(draft.category) || NOT_FILLED },
    { label: "Mode", value: getCompetitionModeLabel(draft.mode) || NOT_FILLED },
    { label: "Lokasi", value: getCompetitionLocationLabel(draft.location) || NOT_FILLED },
    { label: "Pendaftaran dibuka", value: <DraftDate value={draft.registrationStartAt} /> },
    { label: "Pendaftaran ditutup", value: <DraftDate value={draft.registrationEndAt} /> },
    { label: "Pelaksanaan mulai", value: <DraftDate value={draft.eventStartAt} /> },
    { label: "Pelaksanaan selesai", value: <DraftDate value={draft.eventEndAt} /> },
    { label: "Pengumuman hasil", value: <DraftDate value={draft.resultAnnouncementAt} /> },
    { label: "Biaya", value: feeLabelOf(draft) },
    { label: "Kontak penyelenggara", value: contactLabelOf(draft) },
  ];
};

function HostCheckBadge({ overdue }: { overdue: boolean }) {
  return overdue ? (
    <span className="status-badge" data-status="overdue">
      Terlambat
    </span>
  ) : (
    <span className="status-badge" data-status="awaiting">
      Menunggu
    </span>
  );
}

// An approval clears a staff trust removal, so staff see the removal and its reason before they
// decide.
function TrustRemovedNote({ removedAt, reason }: { removedAt: string; reason: string | null }) {
  return (
    <Feedback tone="warning">
      <p>
        Status tepercaya akun ini dicabut staf pada{" "}
        <LocalDate value={removedAt} format="longDate" />. Menyetujui pemeriksaan ini membuat akun
        ini tepercaya lagi.
      </p>
      {reason !== null ? <p>{`Alasan pencabutan: ${reason}`}</p> : null}
    </Feedback>
  );
}

function EarlierTurnDownLine({ turnDown }: { turnDown: EarlierTurnDown }) {
  const guidelineText =
    competitionGuidelineTextOf(turnDown.guidelineItem) ?? turnDown.guidelineItem;
  return (
    <li>
      {"Ditolak "}
      <LocalDate value={turnDown.reviewedAt ?? ""} format="longDate" />
      {`: ${guidelineText} ${turnDown.note ?? ""}`}
    </li>
  );
}

function EarlierTurnDowns({ turnDowns }: { turnDowns: EarlierTurnDown[] }) {
  return (
    <div className="stack-xs">
      <h3>Penolakan sebelumnya</h3>
      <ul className="stack-xs muted-copy">
        {turnDowns.map((turnDown, index) => (
          <EarlierTurnDownLine key={index} turnDown={turnDown} />
        ))}
      </ul>
    </div>
  );
}

function HostCheckCard({
  item,
  onApprove,
  onTurnDown,
}: {
  item: HostCheckQueueItem;
  onApprove: () => void;
  onTurnDown: () => void;
}) {
  return (
    <Card as="li" className="content-section stack-md">
      <div className="section-heading">
        <div>
          <h2>{item.draft.title}</h2>
          <p className="muted-copy">{item.draft.institutionName ?? NOT_FILLED}</p>
        </div>
        <HostCheckBadge overdue={item.overdue} />
      </div>
      {item.host.trustRemovedAt ? (
        <TrustRemovedNote
          removedAt={item.host.trustRemovedAt}
          reason={item.host.trustRemovalReason}
        />
      ) : null}
      <DetailList rows={factRowsOf(item)} />
      {item.draft.description ? (
        <p className="detail-description">{item.draft.description}</p>
      ) : null}
      {item.earlierTurnDowns.length > 0 ? (
        <EarlierTurnDowns turnDowns={item.earlierTurnDowns} />
      ) : null}
      <div className="record-actions">
        <Button type="button" variant="outline" size="sm" onClick={onTurnDown}>
          Tolak
        </Button>
        <Button type="button" size="sm" onClick={onApprove}>
          Setujui dan tayangkan
        </Button>
      </div>
    </Card>
  );
}

// The pop-up footer submits this form. A missing item or note shows its field error and sends
// nothing.
function TurnDownForm({
  onSubmit,
}: {
  onSubmit: (guidelineItem: string, note: string) => Promise<ModalOutcome>;
}) {
  const runModalTask = useModalTask();
  const [guidelineItem, setGuidelineItem] = useState("");
  const [note, setNote] = useState("");
  const [hasTriedToSubmit, setHasTriedToSubmit] = useState(false);
  const trimmedNote = note.trim();
  const showsGuidelineError = hasTriedToSubmit && guidelineItem === "";
  const showsNoteError = hasTriedToSubmit && trimmedNote.length === 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setHasTriedToSubmit(true);
    if (guidelineItem === "" || trimmedNote.length === 0) return;
    void runModalTask(() => onSubmit(guidelineItem, trimmedNote));
  };

  return (
    <form id={TURN_DOWN_FORM_ID} noValidate onSubmit={submit} className="stack-md">
      <FormField>
        <FormLabel htmlFor="host-check-guideline" required>
          Pedoman yang tidak dipenuhi
        </FormLabel>
        <SelectField
          id="host-check-guideline"
          label="Pedoman yang tidak dipenuhi"
          required
          options={GUIDELINE_OPTIONS}
          value={guidelineItem}
          onChange={setGuidelineItem}
        />
        {showsGuidelineError ? (
          <FormError id="host-check-guideline-error">{GUIDELINE_MISSING_MESSAGE}</FormError>
        ) : null}
      </FormField>
      <FormField>
        <FormLabel htmlFor="host-check-note" required>
          Catatan untuk penyelenggara
        </FormLabel>
        <FormTextareaWithLimit
          id="host-check-note"
          value={note}
          maxLength={TURN_DOWN_NOTE_MAX_LENGTH}
          rows={4}
          error={showsNoteError ? NOTE_MISSING_MESSAGE : undefined}
          onChange={(event) => setNote(event.target.value)}
        />
      </FormField>
    </form>
  );
}

// The staff host check queue: open checks on live drafts, oldest first, each approved or turned
// down through the decision route.
export function HostCheckQueue() {
  const { addToast } = useToast();
  const { openModal } = useModal();
  const [queue, setQueue] = useState<QueueState>({ status: "loading" });

  // Reads the queue, or answers null after a toast. It sets no state, so the mount effect and
  // the reload can both await it.
  const fetchHostChecks = useCallback(async (): Promise<HostCheckQueueItem[] | null> => {
    try {
      const response = await fetch(QUEUE_URL);
      if (!response.ok) {
        addToast({ type: "error", message: QUEUE_LOAD_FALLBACK });
        return null;
      }
      const payload = (await response.json()) as { hostChecks: HostCheckQueueItem[] };
      return payload.hostChecks;
    } catch {
      addToast({ type: "error", message: QUEUE_LOAD_NETWORK_MESSAGE });
      return null;
    }
  }, [addToast]);

  const reload = useCallback(async () => {
    setQueue({ status: "loading" });
    setQueue(queueStateOf(await fetchHostChecks()));
  }, [fetchHostChecks]);

  useEffect(() => {
    let active = true;
    void fetchHostChecks().then((items) => {
      if (active) setQueue(queueStateOf(items));
    });
    return () => {
      active = false;
    };
  }, [fetchHostChecks]);

  // The pop-up shows the waiting and a refusal, so this reports an outcome and toasts only the
  // success.
  const requestDecision = useCallback(
    async (checkId: string, body: HostCheckDecisionBody): Promise<ModalOutcome> => {
      const fallback = body.decision === "approve" ? APPROVE_FALLBACK : TURN_DOWN_FALLBACK;
      try {
        const response = await fetch(`${QUEUE_URL}/${encodeURIComponent(checkId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          return { ok: false, message: await decisionRefusalOf(response, fallback) };
        }
        const payload = (await response.json()) as { hostCheck: HostCheckDecisionAnswer };
        addToast({ type: "success", message: decisionSuccessMessageOf(body, payload.hostCheck) });
        void reload();
        return { ok: true };
      } catch {
        return { ok: false, message: NETWORK_ERROR_MESSAGE };
      }
    },
    [addToast, reload],
  );

  const confirmApprove = (item: HostCheckQueueItem) => {
    openModal({
      title: "Setujui dan tayangkan?",
      body: `Akun ini menjadi tepercaya dan draf ${item.draft.title} langsung tayang.`,
      actions: [
        { label: "Batal" },
        {
          label: "Setujui",
          variant: "primary",
          onClick: () => requestDecision(item.id, APPROVE_BODY),
        },
      ],
    });
  };

  const openTurnDown = (item: HostCheckQueueItem) => {
    openModal({
      title: "Tolak pemeriksaan",
      wide: true,
      formId: TURN_DOWN_FORM_ID,
      body: (
        <TurnDownForm
          onSubmit={(guidelineItem, note) =>
            requestDecision(item.id, { decision: "turn_down", guidelineItem, note })
          }
        />
      ),
      actions: [{ label: "Batal" }, { label: "Tolak", variant: "primary" }],
    });
  };

  if (queue.status === "loading") {
    return (
      <div className="content-section stack-sm" aria-label="Memuat pemeriksaan penyelenggara">
        <Skeleton variant="media" />
        <Skeleton variant="media" />
        <Skeleton variant="media" />
      </div>
    );
  }

  if (queue.status === "failed") {
    return (
      <EmptyState
        kind="not-found"
        title="Antrean belum dapat dimuat"
        description="Muat ulang untuk mencoba lagi."
        action={{ label: "Muat ulang", onSelect: () => void reload() }}
      />
    );
  }

  if (queue.items.length === 0) {
    return (
      <EmptyState
        kind="queue-clear"
        title="Antrean sudah bersih"
        description="Tidak ada kompetisi yang menunggu pemeriksaan."
      />
    );
  }

  return (
    <ul className="stack-md">
      {queue.items.map((item) => (
        <HostCheckCard
          key={item.id}
          item={item}
          onApprove={() => confirmApprove(item)}
          onTurnDown={() => openTurnDown(item)}
        />
      ))}
    </ul>
  );
}
