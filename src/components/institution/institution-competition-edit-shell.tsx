"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonLink,
  CheckboxField,
  EmptyState,
  FormActionBar,
  Icon,
  IconButton,
  IconButtonLink,
  PageHeader,
  SelectField,
  Skeleton,
  StepIndicator,
  usePageTransition,
} from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import {
  COMPETITION_EDITOR_PART_LABELS,
  COMPETITION_EDITOR_PART_ORDER,
  CompetitionEditorPartsContext,
  type CompetitionEditorPart,
  type CompetitionEditorPartKey,
  type ReportCompetitionEditorPart,
} from "@/components/institution/competition-editor-parts";
import {
  COMPETITION_STEP_COUNT,
  COMPETITION_STEP_TITLES,
  getCompetitionResumeStep,
  getCompetitionStepHref,
  type CompetitionStep,
} from "@/components/institution/competition-steps";
import {
  COMPETITION_CATEGORY_OPTIONS,
  getCompetitionCategoryLabel,
} from "@/lib/competitions/categories";
import { getCompetitionFieldLabel } from "@/lib/competitions/fields";
import { COMPETITION_MODE_OPTIONS, getCompetitionModeLabel } from "@/lib/competitions/modes";
import { getMissingCompetitionPublishFields } from "@/lib/competitions/competition-publish-required-fields";
import {
  isRegistrationEndPast,
  REGISTRATION_END_PAST_MESSAGE,
  validateCompetitionTimeline,
  type CompetitionTimelineError,
  type CompetitionTimelineField,
} from "@/lib/competitions/competition-timeline";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { resolveSessionMismatchMessage, sessionFetch } from "@/lib/session/session-fetch";
import {
  getPublishBlockerReason,
  resolvePublishReasonHref,
  resolvePublishRefusalToastText,
} from "@/components/institution/competition-publish-messages";
import type { CompetitionPublishReadiness } from "@/server/competitions/competition-publish-readiness";
import { getCompetitionStatusLabel } from "@/lib/competitions/status-labels";
import {
  classifyCompetitionEdit,
  type ClassifiableCompetition,
  type EditClassificationSnapshot,
} from "@/server/competitions/edit-classification";
import {
  CLOSE_WAITS_FOR_TRANSFER_REVIEW_REASON,
  COMPETITION_CHANGED_DURING_EDIT_REASON,
  isPublishLockedField,
  PUBLISH_LOCK_REASONS,
  type PublishLockedField,
} from "@/lib/competitions/publish-locks";
import type { CompetitionCategory } from "@/server/db/schema";

type Category = CompetitionCategory;

type CompetitionStatus = "draft" | "published";
type CompetitionMode = "individual" | "team" | "both";

type Competition = {
  id: string;
  institutionId: string;
  slug: string;
  title: string;
  description: string;
  status: CompetitionStatus;
  category: Category | null;
  mode: CompetitionMode | null;
  minTeamSize: number | null;
  maxTeamSize: number | null;
  registrationStartAt: string | null;
  registrationEndAt: string | null;
  eventStartAt: string | null;
  eventEndAt: string | null;
  resultAnnouncementAt: string | null;
  minimumParticipantEntries: number | null;
  participantConfirmationAt: string | null;
  allowCancellation: boolean;
  cancellationCutoffDays: number | null;
};

type PublishValidationFailure = {
  field: string;
  code: "missing" | "out_of_order" | "not_in_future";
  message: string;
};

type FormSnapshot = {
  title: string;
  slug: string;
  description: string;
  category: string;
  mode: string;
  minTeamSize: string;
  maxTeamSize: string;
  regStart: string;
  regEnd: string;
  evtStart: string;
  evtEnd: string;
  resultAnnounce: string;
  minimumEntries: string;
  participantConfirmation: string;
  allowCancellation: boolean;
  cutoffDays: string;
};

type MainFieldsSaveOutcome =
  | { status: "saved"; sentSnapshot: FormSnapshot }
  | { status: "unchanged" }
  | { status: "failed" };

type RefusalAction = "load" | "save";

const REFUSAL_COPY: Record<RefusalAction, Partial<Record<string, string>>> = {
  load: {
    competition_not_found: "Kompetisi tidak ditemukan.",
    forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
  },
  save: {
    competition_not_found: "Kompetisi tidak ditemukan.",
    forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
    competition_invalid_payload:
      "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
    competition_invalid_value: "Periksa isian formulir lalu coba lagi.",
    competition_field_immutable:
      "Beberapa bidang tidak dapat diubah setelah kompetisi diterbitkan.",
    competition_post_publish_blocked:
      "Perubahan ini tidak dapat disimpan setelah kompetisi terbit.",
    competition_close_waits_for_transfer_review: CLOSE_WAITS_FOR_TRANSFER_REVIEW_REASON,
    competition_changed_during_edit: COMPETITION_CHANGED_DURING_EDIT_REASON,
    competition_publish_validation_failed:
      "Bidang wajib pada kompetisi yang sudah terbit tidak dapat dikosongkan.",
    competition_personal_individual_only:
      "Institusi personal hanya dapat menjalankan kompetisi mode individu.",
    competition_slug_taken:
      "Slug ini sudah dipakai kompetisi lain di institusi ini. Pilih slug lain.",
  },
};

const REFUSAL_FALLBACK: Record<RefusalAction, string> = {
  load: "Data kompetisi gagal dimuat. Muat ulang halaman lalu coba lagi.",
  save: "Perubahan gagal disimpan. Coba lagi.",
};

const extractError = async (
  response: Response,
): Promise<{
  code?: string;
  failures?: PublishValidationFailure[];
  blockedFields?: string[];
}> => {
  try {
    const payload = (await response.json()) as {
      error?: {
        code?: string;
        details?: {
          failures?: PublishValidationFailure[];
          blockedFields?: string[];
          fields?: string[];
        };
      };
    };
    return {
      code: payload.error?.code,
      failures: payload.error?.details?.failures,
      // The competition service names the locked fields in `fields`.
      blockedFields: payload.error?.details?.blockedFields ?? payload.error?.details?.fields,
    };
  } catch {
    return {};
  }
};

const cutoffOrNull = (value: string): number | null => {
  if (value.trim() === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const toDateTimeInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // datetime-local input expects YYYY-MM-DDTHH:mm without timezone.
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const fromDateTimeInput = (value: string): string | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const intOrNull = (value: string): number | null => {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

const minimumEntriesOrDefault = (value: string): number => {
  if (value.trim() === "") return 0;
  return Number.parseInt(value, 10);
};

const getTimelineFieldError = (
  errors: CompetitionTimelineError[],
  field: CompetitionTimelineField,
): string | null => errors.find((error) => error.field === field)?.message ?? null;

const snapshotEquals = (a: FormSnapshot, b: FormSnapshot): boolean =>
  a.title === b.title &&
  a.slug === b.slug &&
  a.description === b.description &&
  a.category === b.category &&
  a.mode === b.mode &&
  a.minTeamSize === b.minTeamSize &&
  a.maxTeamSize === b.maxTeamSize &&
  a.regStart === b.regStart &&
  a.regEnd === b.regEnd &&
  a.evtStart === b.evtStart &&
  a.evtEnd === b.evtEnd &&
  a.resultAnnounce === b.resultAnnounce &&
  a.minimumEntries === b.minimumEntries &&
  a.participantConfirmation === b.participantConfirmation &&
  a.allowCancellation === b.allowCancellation &&
  a.cutoffDays === b.cutoffDays;

const dateFromInput = (value: string): Date | null => {
  const iso = fromDateTimeInput(value);
  return iso === null ? null : new Date(iso);
};

// The editor sees neither registrations nor money. The classifier's publish locks read neither,
// and a later close while a transfer awaits verification is refused by the server alone.
const SNAPSHOT_UNSEEN_BY_THE_EDITOR: EditClassificationSnapshot = {
  nonCancelledCount: 0,
  hasActiveIndividual: false,
  hasActiveTeam: false,
  activeTeamSizes: [],
  hasActiveFree: false,
  hasTransferAwaitingReview: false,
};

// The form's values in the shape saveMainFields sends them. The price belongs to the fee part, so
// both sides of a comparison carry none and it never reads as changed here.
const toClassifiableForm = (values: FormSnapshot): ClassifiableCompetition => ({
  title: values.title,
  slug: values.slug,
  description: values.description,
  category: values.category === "" ? null : (values.category as Category),
  mode: values.mode === "" ? null : (values.mode as CompetitionMode),
  minTeamSize: intOrNull(values.minTeamSize),
  maxTeamSize: intOrNull(values.maxTeamSize),
  registrationStartAt: dateFromInput(values.regStart),
  registrationEndAt: dateFromInput(values.regEnd),
  eventStartAt: dateFromInput(values.evtStart),
  eventEndAt: dateFromInput(values.evtEnd),
  resultAnnouncementAt: dateFromInput(values.resultAnnounce),
  allowCancellation: values.allowCancellation,
  cancellationCutoffDays: values.allowCancellation ? cutoffOrNull(values.cutoffDays) : null,
  feeAmount: null,
  feeCurrency: null,
  paymentWindowDays: 0,
});

// The fields of a published competition's main form that the server would refuse, judged by the
// server's own classifier against the values last loaded.
const findBrokenPublishLocks = (
  saved: FormSnapshot,
  current: FormSnapshot,
): PublishLockedField[] => {
  const classification = classifyCompetitionEdit(
    toClassifiableForm(saved),
    toClassifiableForm(current),
    SNAPSHOT_UNSEEN_BY_THE_EDITOR,
  );
  return classification.blocked.filter(isPublishLockedField);
};

// The ids of the lines that describe a field, or no attribute when there are none.
const describedByIds = (...ids: Array<string | null>): string | undefined => {
  const present = ids.filter((id): id is string => id !== null);
  return present.length > 0 ? present.join(" ") : undefined;
};

// The line under a field that publishing locks or lets move one way only. It becomes the field's
// error while the value on screen is one the server would refuse, keyed apart so the new alert is
// announced.
const PublishLockLine = ({
  id,
  field,
  brokenLocks,
}: {
  id: string;
  field: PublishLockedField;
  brokenLocks: PublishLockedField[];
}) =>
  brokenLocks.includes(field) ? (
    <span key="error" className="form-error" id={id} role="alert">
      {PUBLISH_LOCK_REASONS[field]}
    </span>
  ) : (
    <span key="help" className="form-help" id={id}>
      {PUBLISH_LOCK_REASONS[field]}
    </span>
  );

const describePartSaveFailure = (key: CompetitionEditorPartKey, reason: string): string =>
  `${COMPETITION_EDITOR_PART_LABELS[key]} belum tersimpan. ${reason}`;

// The steps whose fields can be edited: the sections of a published competition.
const SECTION_STEPS = [1, 2, 3, 4] as const;
type SectionStep = (typeof SECTION_STEPS)[number];

type SummaryRow = { term: string; value: string; isLongText?: boolean };

const orEmptyMark = (value: string): string => (value === "" ? "—" : value);

// The detail page's date format prints UTC, which is off by hours in WIB, so step 5 shows the
// form's own value in the browser's time zone instead.
const formatDateTimeInputValue = (value: string): string => orEmptyMark(value.replace("T", " "));

const formatMinimumEntries = (value: string): string =>
  value.trim() === "" ? "—" : Number(value).toLocaleString("id-ID");

const getBasicInfoRows = (values: FormSnapshot): SummaryRow[] => [
  { term: "Judul", value: orEmptyMark(values.title) },
  { term: "Kategori", value: orEmptyMark(getCompetitionCategoryLabel(values.category)) },
  { term: "Deskripsi", value: orEmptyMark(values.description.trim()), isLongText: true },
  { term: "Slug", value: orEmptyMark(values.slug) },
];

const getParticipantRows = (values: FormSnapshot): SummaryRow[] => {
  const hasTeams = values.mode === "team" || values.mode === "both";
  const teamSizeRows = hasTeams
    ? [
        { term: "Min. anggota tim", value: orEmptyMark(values.minTeamSize) },
        { term: "Maks. anggota tim", value: orEmptyMark(values.maxTeamSize) },
      ]
    : [];
  return [
    { term: "Mode", value: orEmptyMark(getCompetitionModeLabel(values.mode)) },
    ...teamSizeRows,
    { term: "Minimum pendaftaran", value: formatMinimumEntries(values.minimumEntries) },
  ];
};

const getScheduleRows = (values: FormSnapshot): SummaryRow[] => [
  { term: "Pendaftaran mulai", value: formatDateTimeInputValue(values.regStart) },
  { term: "Pendaftaran berakhir", value: formatDateTimeInputValue(values.regEnd) },
  { term: "Acara mulai", value: formatDateTimeInputValue(values.evtStart) },
  { term: "Acara berakhir", value: formatDateTimeInputValue(values.evtEnd) },
  { term: "Pengumuman hasil", value: formatDateTimeInputValue(values.resultAnnounce) },
  { term: "Konfirmasi peserta", value: formatDateTimeInputValue(values.participantConfirmation) },
];

const getCancellationRows = (values: FormSnapshot): SummaryRow[] => {
  if (!values.allowCancellation) {
    return [{ term: "Pembatalan oleh peserta", value: "Tidak diizinkan" }];
  }
  const cutoff =
    values.cutoffDays.trim() === "" ? "—" : `${values.cutoffDays} hari sebelum acara mulai`;
  return [
    { term: "Pembatalan oleh peserta", value: "Diizinkan" },
    { term: "Batas pembatalan", value: cutoff },
  ];
};

const SUMMARY_ROWS_BY_STEP: Record<SectionStep, (values: FormSnapshot) => SummaryRow[]> = {
  1: getBasicInfoRows,
  2: getParticipantRows,
  3: getScheduleRows,
  4: getCancellationRows,
};

const ClampedSummaryText = ({ text }: { text: string }) => {
  const textId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || isExpanded) return;
    const measureOverflow = () => setIsOverflowing(element.scrollHeight > element.clientHeight);
    measureOverflow();
    window.addEventListener("resize", measureOverflow);
    return () => window.removeEventListener("resize", measureOverflow);
  }, [text, isExpanded]);

  return (
    <dd className="data-text summary-long-value">
      <div
        ref={textRef}
        id={textId}
        className="summary-long-text"
        data-expanded={isExpanded ? "true" : "false"}
      >
        {text}
      </div>
      {isOverflowing ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={isExpanded}
          aria-controls={textId}
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          {isExpanded ? "Tampilkan lebih sedikit" : "Lihat selengkapnya"}
        </Button>
      ) : null}
    </dd>
  );
};

const StepSummarySection = ({
  step,
  rows,
  editHref,
}: {
  step: SectionStep;
  rows: SummaryRow[];
  editHref: string;
}) => (
  <section className="content-section">
    <div className="section-heading">
      <div>
        <h2>{COMPETITION_STEP_TITLES[step]}</h2>
      </div>
      <IconButtonLink
        href={editHref}
        icon="edit"
        label={`Edit ${COMPETITION_STEP_TITLES[step].toLowerCase()}`}
        variant="outline"
        size="sm"
      />
    </div>
    <dl className="management-detail-grid">
      {rows.map((row) =>
        row.isLongText ? (
          <div key={row.term} className="management-detail-wide">
            <dt>{row.term}</dt>
            <ClampedSummaryText text={row.value} />
          </div>
        ) : (
          <div key={row.term}>
            <dt>{row.term}</dt>
            <dd className="data-text">{row.value}</dd>
          </div>
        ),
      )}
    </dl>
  </section>
);

export const InstitutionCompetitionEditShell = ({
  institutionSlug,
  competitionId,
  expectedUserId,
  initialPublishReadiness,
  isPersonal = false,
  step,
  stepChildren,
  contactEditor,
  children,
}: {
  institutionSlug: string;
  competitionId: string;
  // Rule 16: the rendered-for user id, sent as `X-Expected-User-Id` on every mutation from here.
  expectedUserId: string;
  initialPublishReadiness: CompetitionPublishReadiness;
  // A personal institution may only run individual-mode competitions. When true the
  // mode selector offers individual only (no team/both); the server guard
  // (assertPersonalInstitutionIndividualMode, 422) remains the authoritative enforcement.
  isPersonal?: boolean;
  // Additional authoring surfaces (e.g. the prizes editor) rendered inside the page shell so the
  // page keeps a single <main>. Each reports its unsaved state and its save to the shell, which
  // saves them with the step.
  children?: ReactNode;
  // Absent: the whole editor on one page. Null: the URL named no valid step, so a draft is sent to
  // the step it should resume at, a published competition to section 1. Other statuses ignore it.
  step?: CompetitionStep | null;
  // The same sub-editors grouped by the step that shows them, rendered in place of `children` in
  // step mode so the page does not need to know the competition's status.
  stepChildren?: Partial<Record<1 | 2 | 3 | 4, ReactNode>>;
  // The contact part. The shell places it on a draft's step 5, where Terbitkan saves it before
  // publishing, and in section 1 of a published competition, where Simpan saves it.
  contactEditor?: ReactNode;
}) => {
  const router = useRouter();
  const { openModal } = useModal();
  const { addToast } = useToast();
  const { begin, end, runAndNavigate } = usePageTransition();

  const [competition, setCompetition] = useState<Competition | null>(null);
  // Seeded from the page's server answer, then refreshed by every `load()`. `load()` runs after a
  // successful save, so a save that clears a blocker clears the reason with it — no reload.
  const [publishReadiness, setPublishReadiness] =
    useState<CompetitionPublishReadiness>(initialPublishReadiness);
  // Whether the readiness above came from a live read. A refetch that FAILS leaves the answer
  // UNKNOWN rather than stale: the server is still the authority, and pressing Terbitkan still
  // sends the attempt, whose refusal arrives as Indonesian text via `competition-publish-messages`.
  // Holding the last known value would disable the control on a reason nobody was shown.
  const [readinessIsKnown, setReadinessIsKnown] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Publish shares the submit lock with Save but needs its own flag so the spinner lands on the
  // button that was actually pressed.
  const [isPublishing, setIsPublishing] = useState(false);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("");
  const [mode, setMode] = useState<string>("");
  const [minTeamSize, setMinTeamSize] = useState("");
  const [maxTeamSize, setMaxTeamSize] = useState("");
  const [regStart, setRegStart] = useState("");
  const [regEnd, setRegEnd] = useState("");
  const [evtStart, setEvtStart] = useState("");
  const [evtEnd, setEvtEnd] = useState("");
  const [resultAnnounce, setResultAnnounce] = useState("");
  const [minimumEntries, setMinimumEntries] = useState("0");
  const [participantConfirmation, setParticipantConfirmation] = useState("");
  const [allowCancellation, setAllowCancellation] = useState(false);
  const [cutoffDays, setCutoffDays] = useState("");

  // Track the last-saved snapshot as state (not a ref) so comparisons are safe during render.
  const [savedSnapshot, setSavedSnapshot] = useState<FormSnapshot | null>(null);

  const currentSnapshot = (): FormSnapshot => ({
    title,
    slug,
    description,
    category,
    mode,
    minTeamSize,
    maxTeamSize,
    regStart,
    regEnd,
    evtStart,
    evtEnd,
    resultAnnounce,
    minimumEntries,
    participantConfirmation,
    allowCancellation,
    cutoffDays,
  });

  const restoreFormValues = (snapshot: FormSnapshot) => {
    setTitle(snapshot.title);
    setSlug(snapshot.slug);
    setDescription(snapshot.description);
    setCategory(snapshot.category);
    setMode(snapshot.mode);
    setMinTeamSize(snapshot.minTeamSize);
    setMaxTeamSize(snapshot.maxTeamSize);
    setRegStart(snapshot.regStart);
    setRegEnd(snapshot.regEnd);
    setEvtStart(snapshot.evtStart);
    setEvtEnd(snapshot.evtEnd);
    setResultAnnounce(snapshot.resultAnnounce);
    setMinimumEntries(snapshot.minimumEntries);
    setParticipantConfirmation(snapshot.participantConfirmation);
    setAllowCancellation(snapshot.allowCancellation);
    setCutoffDays(snapshot.cutoffDays);
  };

  const isDraftOrPublished = competition?.status === "draft" || competition?.status === "published";
  // The step a draft shows or the section a published competition shows; null for the single page.
  const activeStep = isDraftOrPublished && typeof step === "number" ? step : null;
  // Which of "Lanjut" and "Simpan dan keluar" is running, so the spinner lands on the pressed one.
  const [pendingStepAction, setPendingStepAction] = useState<"next" | "exit" | null>(null);

  // Every step change drops what was typed and not saved, so a value left on another step is never
  // sent by a later save. Step 5 may open with a suggested contact, which Terbitkan saves.
  const [renderedStep, setRenderedStep] = useState(step);
  if (step !== renderedStep) {
    setRenderedStep(step);
    if (isDraftOrPublished && step !== undefined && savedSnapshot) {
      restoreFormValues(savedSnapshot);
    }
  }

  const isDirty = savedSnapshot !== null && !snapshotEquals(currentSnapshot(), savedSnapshot);

  const [editorParts, setEditorParts] = useState<
    Partial<Record<CompetitionEditorPartKey, CompetitionEditorPart>>
  >({});
  const reportEditorPart = useCallback<ReportCompetitionEditorPart>((key, part) => {
    setEditorParts((previous) => {
      const next = { ...previous };
      delete next[key];
      if (part !== null) next[key] = part;
      return next;
    });
  }, []);

  const partsHaveUnsavedChanges = COMPETITION_EDITOR_PART_ORDER.some(
    (key) => editorParts[key]?.isDirty === true,
  );
  // Step 5 holds only the contact part, and Terbitkan is what saves it, so a contact waiting
  // there neither blocks publishing nor asks before leaving.
  const publishSavesParts = activeStep === COMPETITION_STEP_COUNT;
  const hasUnsavedChanges = isDirty || (!publishSavesParts && partsHaveUnsavedChanges);
  const contactAwaitsPublish = publishSavesParts && editorParts.contact?.isDirty === true;
  const missingPublishFields = getMissingCompetitionPublishFields({
    title,
    description,
    category,
    mode,
    registrationStartAt: regStart,
    registrationEndAt: regEnd,
    eventStartAt: evtStart,
    eventEndAt: evtEnd,
    resultAnnouncementAt: resultAnnounce,
    participantConfirmationAt: participantConfirmation,
  });
  const timelineErrors = validateCompetitionTimeline({
    registrationStartAt: regStart,
    registrationEndAt: regEnd,
    participantConfirmationAt: participantConfirmation,
    eventStartAt: evtStart,
    eventEndAt: evtEnd,
    resultAnnouncementAt: resultAnnounce,
  });
  // Blocks Terbitkan only. It is not a timeline error, because those also block Simpan, and a
  // draft whose window has closed is still a draft the organiser may save. A published competition
  // has no Terbitkan, and its window closing is the normal course, so it is never flagged.
  const registrationEndIsPast = competition?.status === "draft" && isRegistrationEndPast(regEnd);
  const registrationEndError =
    getTimelineFieldError(timelineErrors, "registrationEndAt") ??
    (registrationEndIsPast ? REGISTRATION_END_PAST_MESSAGE : null);
  const participantConfirmationError = getTimelineFieldError(
    timelineErrors,
    "participantConfirmationAt",
  );
  const eventStartError = getTimelineFieldError(timelineErrors, "eventStartAt");
  const eventEndError = getTimelineFieldError(timelineErrors, "eventEndAt");
  const resultAnnouncementError = getTimelineFieldError(timelineErrors, "resultAnnouncementAt");
  const timelineIsInvalid = timelineErrors.length > 0;
  // What the server would refuse on a published competition, judged before anything is sent.
  const brokenPublishLocks: PublishLockedField[] =
    competition?.status === "published" && savedSnapshot !== null
      ? findBrokenPublishLocks(savedSnapshot, currentSnapshot())
      : [];
  const publishLockIsBroken = brokenPublishLocks.length > 0;
  const clientPublishIsBlocked =
    hasUnsavedChanges ||
    missingPublishFields.length > 0 ||
    timelineIsInvalid ||
    registrationEndIsPast;

  // Whether `editorStatusMessage` below is about to say, in this form's own terms, what the
  // checklist reason would say. The two overlap on missing fields, out-of-order dates and a closed
  // registration window and nowhere else, which is why they cannot simply be deduplicated by code.
  const clientChecklistReasonIsRendered =
    timelineIsInvalid || missingPublishFields.length > 0 || registrationEndIsPast;

  // The server's reasons for refusing a publish, in the publish path's order. No reasons are shown
  // against an unknown answer: a reason is a claim about what the server will do, and the shell has
  // just failed to ask it.
  // The server still names a missing contact while the one on step 5 waits for Terbitkan to
  // save it, so that reason is set aside until then.
  const serverBlockers = readinessIsKnown
    ? publishReadiness.blockers.filter(
        (code) => code !== "competition_organizer_contact_missing" || !contactAwaitsPublish,
      )
    : [];
  const serverPublishReasons = serverBlockers
    // Dropped only when the sentence above really is on screen. The server's checklist can
    // refuse for reasons this form has no check for, and dropping the reason there would leave
    // a disabled control with nothing to explain it.
    .filter(
      (code) =>
        code !== "competition_publish_validation_failed" || !clientChecklistReasonIsRendered,
    )
    // This shell IS the page an edit link points at, so such a link is dropped rather than
    // rendered as a control that sends the user to the page they are already on.
    .map((code) => {
      const reason = getPublishBlockerReason(code);
      return reason.link?.kind === "edit" ? { ...reason, link: null } : reason;
    });

  const publishIsBlocked = clientPublishIsBlocked || serverBlockers.length > 0;
  // "siap diterbitkan" is a claim the control has to be able to back, so it is the default only
  // while the control is enabled. When a server refusal is what blocks, that refusal is on screen
  // above this line instead of a sentence here — there is always one, because a block with no client
  // check behind it is a server refusal.
  const readyStatusMessage = contactAwaitsPublish
    ? "Siap diterbitkan. Kontak tersimpan saat Anda menekan Terbitkan."
    : "Semua perubahan tersimpan dan siap diterbitkan";
  let editorStatusMessage: string | null = publishIsBlocked ? null : readyStatusMessage;
  if (timelineIsInvalid) {
    editorStatusMessage = `Perbaiki urutan jadwal: ${timelineErrors[0]?.message}`;
  } else if (hasUnsavedChanges) {
    editorStatusMessage = "Simpan perubahan sebelum menerbitkan";
  } else if (missingPublishFields.length > 0) {
    editorStatusMessage = `Lengkapi untuk menerbitkan: ${missingPublishFields.join(", ")}`;
  } else if (registrationEndIsPast) {
    editorStatusMessage = REGISTRATION_END_PAST_MESSAGE;
  }

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) {
      const { code } = await extractError(response);
      addToast({
        type: "error",
        message: errorMessageFor(code, REFUSAL_COPY.load, REFUSAL_FALLBACK.load),
      });
      // The read failed, so the readiness on screen is no longer an answer to anything. Drop it.
      setReadinessIsKnown(false);
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as {
      competition: Competition;
      publishReadiness?: CompetitionPublishReadiness;
    };
    setCompetition(data.competition);
    if (data.publishReadiness) {
      setPublishReadiness(data.publishReadiness);
    }
    // A successful read clears the unknown state whether or not the optional key came with it: the
    // flag records whether the last READ succeeded, not whether that read carried a new answer.
    // Assigning it only inside the branch above latched the shell — one failed read turned the flag
    // false, and from then on only a response carrying `publishReadiness` could turn it back.
    setReadinessIsKnown(true);
    const loadedTitle = data.competition.title;
    const loadedSlug = data.competition.slug;
    const loadedDescription = data.competition.description ?? "";
    const loadedCategory = data.competition.category ?? "";
    const loadedMode = data.competition.mode ?? "";
    const loadedMinTeamSize = data.competition.minTeamSize?.toString() ?? "";
    const loadedMaxTeamSize = data.competition.maxTeamSize?.toString() ?? "";
    const loadedRegStart = toDateTimeInput(data.competition.registrationStartAt);
    const loadedRegEnd = toDateTimeInput(data.competition.registrationEndAt);
    const loadedEvtStart = toDateTimeInput(data.competition.eventStartAt);
    const loadedEvtEnd = toDateTimeInput(data.competition.eventEndAt);
    const loadedResultAnnounce = toDateTimeInput(data.competition.resultAnnouncementAt);
    const loadedMinimumEntries = data.competition.minimumParticipantEntries?.toString() ?? "0";
    const loadedParticipantConfirmation = toDateTimeInput(
      data.competition.participantConfirmationAt,
    );
    const loadedAllowCancellation = data.competition.allowCancellation ?? false;
    const loadedCutoffDays = data.competition.cancellationCutoffDays?.toString() ?? "";

    setTitle(loadedTitle);
    setSlug(loadedSlug);
    setDescription(loadedDescription);
    setCategory(loadedCategory);
    setMode(loadedMode);
    setMinTeamSize(loadedMinTeamSize);
    setMaxTeamSize(loadedMaxTeamSize);
    setRegStart(loadedRegStart);
    setRegEnd(loadedRegEnd);
    setEvtStart(loadedEvtStart);
    setEvtEnd(loadedEvtEnd);
    setResultAnnounce(loadedResultAnnounce);
    setMinimumEntries(loadedMinimumEntries);
    setParticipantConfirmation(loadedParticipantConfirmation);
    setAllowCancellation(loadedAllowCancellation);
    setCutoffDays(loadedCutoffDays);

    setSavedSnapshot({
      title: loadedTitle,
      slug: loadedSlug,
      description: loadedDescription,
      category: loadedCategory,
      mode: loadedMode,
      minTeamSize: loadedMinTeamSize,
      maxTeamSize: loadedMaxTeamSize,
      regStart: loadedRegStart,
      regEnd: loadedRegEnd,
      evtStart: loadedEvtStart,
      evtEnd: loadedEvtEnd,
      resultAnnounce: loadedResultAnnounce,
      minimumEntries: loadedMinimumEntries,
      participantConfirmation: loadedParticipantConfirmation,
      allowCancellation: loadedAllowCancellation,
      cutoffDays: loadedCutoffDays,
    });
    setIsLoading(false);
  }, [competitionId, addToast]);

  const endThrownReload = () => {
    addToast({ type: "error", message: REFUSAL_FALLBACK.load });
    setReadinessIsKnown(false);
    setIsLoading(false);
  };

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // A contact waiting on step 5 does not count as unsaved here, because Terbitkan saves it.
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (competition?.status === "published") {
      addToast({
        type: "info",
        message:
          "Kompetisi ini sudah terbit. Perubahan yang memengaruhi peserta akan mengirim notifikasi. Bidang yang terkunci menyebutkan alasannya di bawahnya.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competition?.status]);

  useEffect(() => {
    if (competition && competition.status !== "draft" && competition.status !== "published") {
      addToast({
        type: "error",
        message: `Kompetisi berstatus ${getCompetitionStatusLabel(competition.status)} tidak dapat diubah.`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competition?.status]);

  useEffect(() => {
    if (isPersonal) {
      addToast({
        type: "info",
        message: "Institusi personal hanya dapat menjalankan kompetisi mode individu.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPersonal]);

  // "Lanjut", the step "Kembali" and the "Tinggalkan" of a section link arrive as a step change,
  // which ends their screen.
  useEffect(() => {
    if (step === undefined) return;
    end();
  }, [step, end]);

  useEffect(() => {
    if (step !== null || competition?.status !== "draft" || !savedSnapshot) return;
    const resumeStep = getCompetitionResumeStep({
      title: savedSnapshot.title,
      description: savedSnapshot.description,
      category: savedSnapshot.category,
      mode: savedSnapshot.mode,
      minTeamSize: savedSnapshot.minTeamSize,
      maxTeamSize: savedSnapshot.maxTeamSize,
      registrationStartAt: savedSnapshot.regStart,
      registrationEndAt: savedSnapshot.regEnd,
      eventStartAt: savedSnapshot.evtStart,
      eventEndAt: savedSnapshot.evtEnd,
      resultAnnouncementAt: savedSnapshot.resultAnnounce,
      participantConfirmationAt: savedSnapshot.participantConfirmation,
    });
    router.replace(getCompetitionStepHref(institutionSlug, savedSnapshot.slug, resumeStep));
  }, [step, competition?.status, savedSnapshot, institutionSlug, router]);

  // A published competition has no step 5, so a missing or review step opens its first section.
  useEffect(() => {
    if (competition?.status !== "published" || !savedSnapshot) return;
    if (step !== null && step !== COMPETITION_STEP_COUNT) return;
    router.replace(getCompetitionStepHref(institutionSlug, savedSnapshot.slug, 1));
  }, [step, competition?.status, savedSnapshot, institutionSlug, router]);

  // Sends the main fields, or nothing for a published form without changes. A refusal shows its own
  // toast or modal. A request that throws escapes to saveCurrentStep.
  const saveMainFields = async (): Promise<MainFieldsSaveOutcome> => {
    if (timelineIsInvalid) {
      addToast({
        type: "error",
        message: `Perbaiki urutan jadwal: ${timelineErrors.map(({ message }) => message).join(" ")}`,
      });
      return { status: "failed" };
    }
    const firstBrokenLock = brokenPublishLocks[0];
    if (firstBrokenLock !== undefined) {
      addToast({ type: "error", message: PUBLISH_LOCK_REASONS[firstBrokenLock] });
      return { status: "failed" };
    }
    if (isPublished && !isDirty) return { status: "unchanged" };

    const sentSnapshot = currentSnapshot();
    const patch: Record<string, unknown> = {
      title,
      slug,
      description,
      category: category === "" ? null : category,
      ...(!isPublished && {
        mode: mode === "" ? null : mode,
        minimumParticipantEntries: minimumEntriesOrDefault(minimumEntries),
        participantConfirmationAt: fromDateTimeInput(participantConfirmation),
      }),
      minTeamSize: intOrNull(minTeamSize),
      maxTeamSize: intOrNull(maxTeamSize),
      registrationStartAt: fromDateTimeInput(regStart),
      registrationEndAt: fromDateTimeInput(regEnd),
      eventStartAt: fromDateTimeInput(evtStart),
      eventEndAt: fromDateTimeInput(evtEnd),
      resultAnnouncementAt: fromDateTimeInput(resultAnnounce),
      allowCancellation,
      cancellationCutoffDays: allowCancellation ? cutoffOrNull(cutoffDays) : null,
    };

    if (isPublished && savedSnapshot) {
      const unchangedFields = {
        title: title === savedSnapshot.title,
        slug: slug === savedSnapshot.slug,
        description: description === savedSnapshot.description,
        category: category === savedSnapshot.category,
        minTeamSize: minTeamSize === savedSnapshot.minTeamSize,
        maxTeamSize: maxTeamSize === savedSnapshot.maxTeamSize,
        registrationStartAt: regStart === savedSnapshot.regStart,
        registrationEndAt: regEnd === savedSnapshot.regEnd,
        eventStartAt: evtStart === savedSnapshot.evtStart,
        eventEndAt: evtEnd === savedSnapshot.evtEnd,
        resultAnnouncementAt: resultAnnounce === savedSnapshot.resultAnnounce,
        allowCancellation: allowCancellation === savedSnapshot.allowCancellation,
        cancellationCutoffDays:
          cutoffDays === savedSnapshot.cutoffDays &&
          allowCancellation === savedSnapshot.allowCancellation,
      };
      for (const [field, unchanged] of Object.entries(unchangedFields)) {
        if (unchanged) delete patch[field];
      }
    }

    const response = await sessionFetch(
      expectedUserId,
      `/api/v1/competitions/${encodeURIComponent(competitionId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
    );

    if (!response.ok) {
      const { code, blockedFields } = await extractError(response);
      const message = errorMessageFor(code, REFUSAL_COPY.save, REFUSAL_FALLBACK.save);
      // A close that waits for a transfer is not a publish lock, so the modal says what to do
      // instead of naming locked fields and the unpublish route.
      if (code === "competition_close_waits_for_transfer_review") {
        openModal({
          title: "Perubahan belum dapat disimpan",
          closeable: true,
          body: <p className="muted-copy">{message}</p>,
          actions: [{ label: "Mengerti", variant: "primary", autoClose: true, onClick: () => {} }],
        });
        return { status: "failed" };
      }
      // A post-publish blocked or immutable-field edit is surfaced in a modal naming the
      // offending field(s) and why, per the shared-primitive rule.
      if (code === "competition_post_publish_blocked" || code === "competition_field_immutable") {
        const fields = blockedFields ?? [];
        openModal({
          title:
            code === "competition_field_immutable"
              ? "Bidang tidak dapat diubah"
              : "Perubahan ditolak",
          closeable: true,
          body: (
            <div className="stack-sm">
              <p className="muted-copy">
                {code === "competition_field_immutable"
                  ? "Bidang berikut tidak dapat diubah setelah kompetisi diterbitkan:"
                  : "Perubahan berikut tidak dapat disimpan setelah kompetisi terbit:"}
              </p>
              <ul>
                {fields.map((f) => (
                  <li key={f}>{getCompetitionFieldLabel(f)}</li>
                ))}
              </ul>
              <p className="form-help">
                Untuk mengubah bidang ini, batalkan publikasi kompetisi terlebih dahulu (ini akan
                membatalkan semua pendaftaran yang ada).
              </p>
            </div>
          ),
          actions: [{ label: "Mengerti", variant: "primary", autoClose: true, onClick: () => {} }],
        });
        addToast({ type: "error", message });
        return { status: "failed" };
      }
      addToast({ type: "error", message });
      return { status: "failed" };
    }

    return { status: "saved", sentSnapshot };
  };

  // Saves each part of this step that has unsaved changes, in COMPETITION_EDITOR_PART_ORDER, and
  // stops at the first that fails, naming it.
  const saveChangedParts = async (): Promise<boolean> => {
    for (const key of COMPETITION_EDITOR_PART_ORDER) {
      const part = editorParts[key];
      if (!part?.isDirty) continue;
      const result = await part.save();
      if (!result.ok) {
        addToast({ type: "error", message: describePartSaveFailure(key, result.errorMessage) });
        return false;
      }
    }
    return true;
  };

  // Saves the main fields, then each changed part of this step. Resolves to the main form values
  // now saved when everything saved, and to null when anything failed, with the failure already
  // shown.
  const saveCurrentStep = async (): Promise<FormSnapshot | null> => {
    setIsSubmitting(true);
    try {
      const mainOutcome = await saveMainFields();
      if (mainOutcome.status === "failed") return null;
      if (mainOutcome.status === "saved") {
        // The step change restores savedSnapshot, so it must hold what was just saved.
        // load() waits until every part has saved: its skeleton unmounts the parts and would drop
        // what is typed in them.
        setSavedSnapshot(mainOutcome.sentSnapshot);
      }
      const partsSaved = await saveChangedParts();
      if (!partsSaved) return null;
      addToast({ type: "success", message: "Perubahan tersimpan." });
      void load().catch(endThrownReload);
      if (mainOutcome.status === "unchanged") return currentSnapshot();
      return mainOutcome.sentSnapshot;
    } catch {
      addToast({ type: "error", message: NETWORK_ERROR_MESSAGE });
      return null;
    } finally {
      setIsSubmitting(false);
    }
  };

  const onSaveSection = (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (isSubmitting) return;
    void saveCurrentStep();
  };

  const listHref = `/institution/${institutionSlug}/competitions`;
  // URLs of this competition follow the last saved slug, which a step-1 save may have just changed.
  // The step controls render only after the load, so the id fallback is never shown.
  const savedCompetitionSlug = savedSnapshot?.slug ?? competitionId;

  const onNextStep = async () => {
    if (isSubmitting) return;
    if (activeStep === null || activeStep === COMPETITION_STEP_COUNT) return;
    const nextStep = (activeStep + 1) as CompetitionStep;
    setPendingStepAction("next");
    begin("Menyimpan kompetisi…");
    const savedValues = await saveCurrentStep();
    setPendingStepAction(null);
    if (!savedValues) {
      end();
      return;
    }
    router.push(getCompetitionStepHref(institutionSlug, savedValues.slug, nextStep));
  };

  const onStepFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onNextStep();
  };

  const onSaveAndExit = () =>
    runAndNavigate(
      async () => {
        setPendingStepAction("exit");
        const savedValues = await saveCurrentStep();
        setPendingStepAction(null);
        if (!savedValues) return false;
        router.push(listHref);
        return true;
      },
      { message: "Menyimpan kompetisi…" },
    );

  // Resolves to whether the competition was published.
  const publishCompetition = async (): Promise<boolean> => {
    if (publishIsBlocked) {
      // The client's own reasons first: they are the ones this shell can see and the user can act
      // on here. If only the server is refusing, say what it said.
      addToast({
        type: "error",
        message: clientPublishIsBlocked
          ? timelineIsInvalid
            ? `Perbaiki urutan jadwal: ${timelineErrors.map(({ message }) => message).join(" ")}`
            : hasUnsavedChanges
              ? "Simpan perubahan sebelum menerbitkan kompetisi."
              : missingPublishFields.length > 0
                ? `Lengkapi bidang wajib sebelum menerbitkan: ${missingPublishFields.join(", ")}.`
                : REGISTRATION_END_PAST_MESSAGE
          : (serverPublishReasons[0]?.text ?? "Kompetisi belum dapat diterbitkan saat ini."),
      });
      return false;
    }

    setIsSubmitting(true);
    setIsPublishing(true);
    const url = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}/publish`;
    try {
      if (publishSavesParts) {
        const partsSaved = await saveChangedParts();
        if (!partsSaved) return false;
      }
      const response = await sessionFetch(expectedUserId, url, { method: "POST" });
      if (!response.ok) {
        const { code, failures } = await extractError(response);
        addToast({
          type: "error",
          message: resolveSessionMismatchMessage(
            code,
            resolvePublishRefusalToastText(code, failures),
          ),
        });
        // The readiness on screen was read before this attempt saved the contact.
        if (publishSavesParts) void load().catch(endThrownReload);
        return false;
      }
      addToast({ type: "success", message: "Kompetisi diterbitkan." });
      return true;
    } catch {
      addToast({ type: "error", message: NETWORK_ERROR_MESSAGE });
      return false;
    } finally {
      setIsSubmitting(false);
      setIsPublishing(false);
    }
  };

  const onPublish = async () => {
    const published = await publishCompetition();
    if (published) void load();
  };

  // No reload after a publish that succeeds: the user is leaving the editor, and a reload would
  // announce a published competition here. A refused publish reloads inside publishCompetition.
  const onPublishAndOpenManagement = () =>
    runAndNavigate(
      async () => {
        const published = await publishCompetition();
        if (!published) return false;
        router.push(
          `/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(savedCompetitionSlug)}`,
        );
        return true;
      },
      { message: "Menerbitkan kompetisi…" },
    );

  // Page routes are slug-keyed, so the back control follows the last saved slug, which a save can
  // change before one of its parts fails.
  const backUrl = `/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(savedCompetitionSlug)}`;

  // Step 1 leaves for the list, whose route skeleton is its waiting signal. Steps 2 to 5 stay on
  // this path, which shows no skeleton, so the transition screen covers the wait instead.
  const openBackTarget = () => {
    if (activeStep === null || competition?.status !== "draft") {
      router.push(backUrl);
      return;
    }
    if (activeStep === 1) {
      router.push(listHref);
      return;
    }
    const previousStep = (activeStep - 1) as CompetitionStep;
    begin("Membuka langkah sebelumnya…");
    router.push(getCompetitionStepHref(institutionSlug, savedCompetitionSlug, previousStep));
  };

  const confirmLeavingUnsavedChanges = (leave: () => void) => {
    openModal({
      title: "Perubahan belum tersimpan",
      body: "Anda memiliki perubahan yang belum disimpan. Yakin ingin meninggalkan halaman ini?",
      closeable: true,
      actions: [
        {
          label: "Tinggalkan",
          variant: "danger",
          autoClose: true,
          onClick: leave,
        },
        {
          label: "Tetap di sini",
          variant: "secondary",
          autoClose: true,
          onClick: () => {},
        },
      ],
    });
  };

  const handleBack = () => {
    if (!hasUnsavedChanges) {
      openBackTarget();
      return;
    }
    confirmLeavingUnsavedChanges(openBackTarget);
  };

  const onSectionLinkClick = (
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string,
    isCurrentSection: boolean,
  ) => {
    if (!hasUnsavedChanges || isCurrentSection) return;
    event.preventDefault();
    confirmLeavingUnsavedChanges(() => {
      begin("Membuka bagian kompetisi…");
      router.push(href);
    });
  };

  // A draft opened without a valid step keeps the skeleton until the resume step's URL arrives.
  const isAwaitingResumeStep = step === null && competition?.status === "draft";
  // A published competition opened without a section keeps it until section 1's URL arrives.
  const isAwaitingFirstSection =
    competition?.status === "published" && (step === null || step === COMPETITION_STEP_COUNT);

  if (isLoading || isAwaitingResumeStep || isAwaitingFirstSection) {
    return (
      <main className="page-shell app-page competition-form-page">
        <div className="stack-md" aria-label="Memuat formulir kompetisi">
          <Skeleton variant="title" />
          <Skeleton variant="media" />
          <Skeleton variant="media" />
        </div>
      </main>
    );
  }

  if (!competition) {
    return (
      <main className="page-shell app-page competition-form-page">
        <EmptyState
          icon="trophy"
          title="Kompetisi tidak ditemukan"
          description="Formulir kompetisi tidak dapat dimuat."
          action={
            <ButtonLink href={`/institution/${institutionSlug}/competitions`} variant="outline">
              Kembali ke daftar
            </ButtonLink>
          }
        />
      </main>
    );
  }

  const isDraft = competition.status === "draft";
  const isEditable = competition.status === "draft" || competition.status === "published";
  // Publishing locks some fields and lets others move one way only. Each says so in a line under
  // it, and a value the server would refuse holds Simpan back (brokenPublishLocks).
  const isPublished = competition.status === "published";
  const modeLockReason = PUBLISH_LOCK_REASONS.mode;
  const registrationEndFloor = isPublished ? savedSnapshot?.regEnd : regStart;
  const eventStartFloor = isPublished ? savedSnapshot?.evtStart : participantConfirmation || regEnd;
  const savedMinTeamSize =
    isPublished && savedSnapshot ? intOrNull(savedSnapshot.minTeamSize) : null;
  const savedMaxTeamSize =
    isPublished && savedSnapshot ? intOrNull(savedSnapshot.maxTeamSize) : null;
  const showsMinTeamSizeLock = isPublished && mode === "team";
  const showsMaxTeamSizeLock = isPublished && mode !== "individual";
  const cancellationRightIsLocked = isPublished && savedSnapshot?.allowCancellation === true;
  const savedCutoffDays =
    cancellationRightIsLocked && savedSnapshot ? cutoffOrNull(savedSnapshot.cutoffDays) : null;
  const showsStep = (blockStep: CompetitionStep) => activeStep === null || activeStep === blockStep;
  const showsContactEditor =
    contactEditor !== undefined &&
    ((isDraft && activeStep === COMPETITION_STEP_COUNT) || (isPublished && activeStep === 1));

  const titleField = (
    <label className="form-field">
      <span className="form-label form-label-required">Judul</span>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
        minLength={5}
        maxLength={200}
        className="form-input"
      />
    </label>
  );
  const slugField = (
    <label className="form-field">
      <span className="form-label">Slug</span>
      <input
        type="text"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        disabled={isPublished}
        className="form-input"
        aria-describedby={isPublished ? "slug-lock" : undefined}
      />
      {isPublished ? (
        <PublishLockLine id="slug-lock" field="slug" brokenLocks={brokenPublishLocks} />
      ) : (
        <span className="form-help">Gunakan huruf kecil, angka, dan tanda hubung.</span>
      )}
    </label>
  );
  const descriptionField = (
    <label className="form-field">
      <span className="form-label form-label-required">Deskripsi</span>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        required
        rows={4}
        maxLength={10000}
        className="form-textarea"
      />
    </label>
  );
  const categoryField = (
    <div className="form-field">
      <span className="form-label form-label-required" id="competition-category-label">
        Kategori
      </span>
      <SelectField
        label="Kategori"
        id="competition-category-label"
        value={category}
        placeholder="Pilih"
        required
        options={[...COMPETITION_CATEGORY_OPTIONS]}
        onChange={setCategory}
      />
    </div>
  );

  // Today's single page shows both fields under one help line; the steps split them, so the
  // confirmation field gets its own help id there.
  const minimumParticipationHeading = (
    <>
      <legend className="sr-only">Minimum peserta</legend>
      <div className="section-heading">
        <div>
          <h2>Minimum peserta</h2>
        </div>
      </div>
    </>
  );
  const minimumParticipationHelp = isPublished ? (
    <p className="form-help" id="minimum-participation-help">
      Minimum peserta dan waktu konfirmasi tidak dapat diubah setelah kompetisi terbit.
    </p>
  ) : (
    <p className="form-help" id="minimum-participation-help">
      Nilai 0 berarti tidak ada minimum. Satu peserta individu atau satu tim dihitung sebagai satu
      pendaftaran.
    </p>
  );
  const minimumEntriesField = (
    <label className="form-field">
      <span className="form-label">Minimum pendaftaran</span>
      <input
        type="number"
        value={minimumEntries}
        onChange={(event) => setMinimumEntries(event.target.value)}
        onBlur={() => {
          if (minimumEntries.trim() === "") setMinimumEntries("0");
        }}
        min={0}
        disabled={isPublished}
        className="form-input"
        aria-describedby="minimum-participation-help"
      />
    </label>
  );
  let participantConfirmationHelpIds = "participant-confirmation-help";
  if (activeStep === null) {
    participantConfirmationHelpIds = "minimum-participation-help";
  } else if (isPublished) {
    participantConfirmationHelpIds = "minimum-participation-help participant-confirmation-help";
  }
  const participantConfirmationField = (
    <label className="form-field">
      <span className="form-label form-label-required">Konfirmasi peserta</span>
      <input
        type="datetime-local"
        value={participantConfirmation}
        onChange={(event) => setParticipantConfirmation(event.target.value)}
        min={regEnd || undefined}
        max={evtStart || undefined}
        required
        disabled={isPublished}
        className="form-input"
        aria-invalid={participantConfirmationError ? true : undefined}
        aria-describedby={
          participantConfirmationError
            ? `${participantConfirmationHelpIds} participant-confirmation-timeline-error`
            : participantConfirmationHelpIds
        }
      />
      {participantConfirmationError ? (
        <span className="form-error" id="participant-confirmation-timeline-error" role="alert">
          {participantConfirmationError}
        </span>
      ) : null}
    </label>
  );
  const participantConfirmationHelp = (
    <p className="form-help" id={activeStep === null ? undefined : "participant-confirmation-help"}>
      Waktu konfirmasi harus berada pada atau setelah pendaftaran berakhir dan sebelum acara mulai.
      Jika minimum di atas 0 dan belum tercapai saat itu, penyelenggara dapat membatalkan atau tetap
      menjalankan kompetisi.
    </p>
  );

  const publishReadinessNote = (
    <div
      className="record-meta"
      id="publish-readiness-message"
      data-dirty={publishIsBlocked ? "true" : undefined}
    >
      {/* Server reasons first: what the server will do outranks what this form thinks of
          itself, and a reason the user cannot fix here is the one worth reading first. */}
      {serverPublishReasons.length > 0 ? (
        <ul className="stack-xs">
          {serverPublishReasons.map((reason) => (
            <li key={reason.code}>
              {reason.text}
              {reason.link ? (
                <>
                  {" "}
                  <Link
                    href={resolvePublishReasonHref(reason.link.kind, {
                      institutionSlug,
                      competitionSlug: savedCompetitionSlug,
                    })}
                  >
                    {reason.link.label}
                  </Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <span>{editorStatusMessage}</span>
    </div>
  );

  const sectionNav = (
    <nav aria-label="Bagian kompetisi" className="cluster">
      {SECTION_STEPS.map((sectionStep) => {
        const href = getCompetitionStepHref(institutionSlug, savedCompetitionSlug, sectionStep);
        const isCurrentSection = sectionStep === activeStep;
        return (
          <ButtonLink
            key={sectionStep}
            href={href}
            size="sm"
            variant={isCurrentSection ? "primary" : "outline"}
            aria-current={isCurrentSection ? "page" : undefined}
            onClick={(event) => onSectionLinkClick(event, href, isCurrentSection)}
          >
            {COMPETITION_STEP_TITLES[sectionStep]}
          </ButtonLink>
        );
      })}
    </nav>
  );

  // Every step change resets the form to savedSnapshot and every load sets both, so the form state
  // read here is what was saved.
  const formValues = currentSnapshot();
  const stepSummarySections = SECTION_STEPS.map((summaryStep) => (
    <StepSummarySection
      key={summaryStep}
      step={summaryStep}
      rows={SUMMARY_ROWS_BY_STEP[summaryStep](formValues)}
      editHref={getCompetitionStepHref(institutionSlug, savedCompetitionSlug, summaryStep)}
    />
  ));

  const isDraftStep = activeStep !== null && isDraft;
  const stepPartsNode =
    activeStep === null ? children : activeStep === 5 ? null : stepChildren?.[activeStep];
  const editorPartsNode = showsContactEditor ? (
    <>
      {stepPartsNode}
      {contactEditor}
    </>
  ) : (
    stepPartsNode
  );

  return (
    <main className="page-shell app-page competition-form-page">
      <PageHeader
        title={competition.title}
        actions={
          <span className="status-badge" data-status={isPublished ? "open" : "closing"}>
            {getCompetitionStatusLabel(competition.status)}
          </span>
        }
      />
      {activeStep !== null && isPublished ? sectionNav : null}
      {isDraftStep ? (
        <StepIndicator
          current={activeStep}
          total={COMPETITION_STEP_COUNT}
          label={COMPETITION_STEP_TITLES[activeStep]}
        />
      ) : null}

      {!isEditable || activeStep === 5 ? null : (
        <form
          onSubmit={isDraftStep ? onStepFormSubmit : onSaveSection}
          className="competition-edit-form"
        >
          <fieldset className="competition-edit-form-fields" role="none" disabled={isSubmitting}>
            {showsStep(1) ? (
              <section className="content-section">
                <div className="section-heading">
                  <div>
                    <h2>Informasi utama</h2>
                  </div>
                </div>
                {activeStep === null ? (
                  <>
                    {titleField}
                    {slugField}
                    {descriptionField}
                    {categoryField}
                  </>
                ) : (
                  <>
                    {titleField}
                    {categoryField}
                    {descriptionField}
                    {slugField}
                  </>
                )}
              </section>
            ) : null}

            {showsStep(2) ? (
              <section className="content-section">
                <div className="section-heading">
                  <div>
                    <h2>Mode dan ukuran tim</h2>
                  </div>
                </div>
                {isPublished ? <p className="form-help">{modeLockReason}</p> : null}
                <div className="form-field">
                  <span className="form-label form-label-required" id="competition-mode-label">
                    Mode
                  </span>
                  {/* Personal institutions are individual-only. */}
                  <SelectField
                    label="Mode"
                    id="competition-mode-label"
                    value={mode}
                    disabled={isPublished}
                    required
                    placeholder="Pilih"
                    options={
                      isPersonal
                        ? COMPETITION_MODE_OPTIONS.filter((option) => option.value === "individual")
                        : [...COMPETITION_MODE_OPTIONS]
                    }
                    onChange={(newMode) => {
                      setMode(newMode);
                      // Mode-driven team-size behaviour:
                      //   individual → fixed 1/1, both fields disabled
                      //   team       → default 2/2, both fields editable
                      //   both       → min fixed at 1 (disabled), max editable (default 2)
                      if (newMode === "individual") {
                        setMinTeamSize("1");
                        setMaxTeamSize("1");
                      } else if (newMode === "team") {
                        setMinTeamSize("2");
                        setMaxTeamSize("2");
                      } else if (newMode === "both") {
                        setMinTeamSize("1");
                        if (!maxTeamSize || Number.parseInt(maxTeamSize, 10) < 1) {
                          setMaxTeamSize("2");
                        }
                      }
                    }}
                  />
                </div>
                <div className="form-grid">
                  <label className="form-field">
                    <span className="form-label">Min. anggota tim</span>
                    <input
                      type="number"
                      value={minTeamSize}
                      onChange={(e) => setMinTeamSize(e.target.value)}
                      min={mode === "team" ? 2 : 1}
                      max={savedMinTeamSize ?? undefined}
                      // Min is fixed for individual (1) and both (1); only team allows editing min.
                      disabled={mode === "individual" || mode === "both"}
                      className="form-input"
                      aria-invalid={brokenPublishLocks.includes("minTeamSize") ? true : undefined}
                      aria-describedby={showsMinTeamSizeLock ? "min-team-size-lock" : undefined}
                    />
                    {showsMinTeamSizeLock ? (
                      <PublishLockLine
                        id="min-team-size-lock"
                        field="minTeamSize"
                        brokenLocks={brokenPublishLocks}
                      />
                    ) : null}
                  </label>
                  <label className="form-field">
                    <span className="form-label">Maks. anggota tim</span>
                    <input
                      type="number"
                      value={maxTeamSize}
                      onChange={(e) => setMaxTeamSize(e.target.value)}
                      min={savedMaxTeamSize ?? 1}
                      // Max is fixed for individual (1); team and both allow editing max.
                      disabled={mode === "individual"}
                      className="form-input"
                      aria-invalid={brokenPublishLocks.includes("maxTeamSize") ? true : undefined}
                      aria-describedby={showsMaxTeamSizeLock ? "max-team-size-lock" : undefined}
                    />
                    {showsMaxTeamSizeLock ? (
                      <PublishLockLine
                        id="max-team-size-lock"
                        field="maxTeamSize"
                        brokenLocks={brokenPublishLocks}
                      />
                    ) : null}
                  </label>
                </div>
              </section>
            ) : null}

            {showsStep(3) ? (
              <section className="content-section">
                <div className="section-heading">
                  <div>
                    <h2>Jadwal kompetisi</h2>
                  </div>
                </div>
                <div className="form-grid">
                  <label className="form-field">
                    <span className="form-label form-label-required">Pendaftaran mulai</span>
                    <input
                      type="datetime-local"
                      value={regStart}
                      onChange={(e) => setRegStart(e.target.value)}
                      max={regEnd || undefined}
                      required
                      className="form-input"
                    />
                  </label>
                  <label className="form-field">
                    <span className="form-label form-label-required">Pendaftaran berakhir</span>
                    <input
                      type="datetime-local"
                      value={regEnd}
                      onChange={(e) => setRegEnd(e.target.value)}
                      min={registrationEndFloor || undefined}
                      max={participantConfirmation || evtStart || undefined}
                      required
                      className="form-input"
                      aria-invalid={
                        registrationEndError || brokenPublishLocks.includes("registrationEndAt")
                          ? true
                          : undefined
                      }
                      aria-describedby={describedByIds(
                        isPublished ? "registration-end-lock" : null,
                        registrationEndError ? "registration-end-timeline-error" : null,
                      )}
                    />
                    {registrationEndError ? (
                      <span
                        className="form-error"
                        id="registration-end-timeline-error"
                        role="alert"
                      >
                        {registrationEndError}
                      </span>
                    ) : null}
                    {isPublished ? (
                      <PublishLockLine
                        id="registration-end-lock"
                        field="registrationEndAt"
                        brokenLocks={brokenPublishLocks}
                      />
                    ) : null}
                  </label>
                  <label className="form-field">
                    <span className="form-label form-label-required">Acara mulai</span>
                    <input
                      type="datetime-local"
                      value={evtStart}
                      onChange={(e) => setEvtStart(e.target.value)}
                      min={eventStartFloor || undefined}
                      max={evtEnd || undefined}
                      required
                      className="form-input"
                      aria-invalid={
                        eventStartError || brokenPublishLocks.includes("eventStartAt")
                          ? true
                          : undefined
                      }
                      aria-describedby={describedByIds(
                        isPublished ? "event-start-lock" : null,
                        eventStartError ? "event-start-timeline-error" : null,
                      )}
                    />
                    {eventStartError ? (
                      <span className="form-error" id="event-start-timeline-error" role="alert">
                        {eventStartError}
                      </span>
                    ) : null}
                    {isPublished ? (
                      <PublishLockLine
                        id="event-start-lock"
                        field="eventStartAt"
                        brokenLocks={brokenPublishLocks}
                      />
                    ) : null}
                  </label>
                  <label className="form-field">
                    <span className="form-label form-label-required">Acara berakhir</span>
                    <input
                      type="datetime-local"
                      value={evtEnd}
                      onChange={(e) => setEvtEnd(e.target.value)}
                      min={evtStart || undefined}
                      max={resultAnnounce || undefined}
                      required
                      className="form-input"
                      aria-invalid={
                        eventEndError || brokenPublishLocks.includes("eventEndAt")
                          ? true
                          : undefined
                      }
                      aria-describedby={describedByIds(
                        isPublished ? "event-end-lock" : null,
                        eventEndError ? "event-end-timeline-error" : null,
                      )}
                    />
                    {eventEndError ? (
                      <span className="form-error" id="event-end-timeline-error" role="alert">
                        {eventEndError}
                      </span>
                    ) : null}
                    {isPublished ? (
                      <PublishLockLine
                        id="event-end-lock"
                        field="eventEndAt"
                        brokenLocks={brokenPublishLocks}
                      />
                    ) : null}
                  </label>
                  {/* The hint sits in the grid's second column rather than under the input, so the
                  field keeps the same height as the four date fields above it. */}
                  <div className="form-field-with-aside">
                    <label className="form-field">
                      <span className="form-label form-label-required">Pengumuman hasil</span>
                      <input
                        type="datetime-local"
                        value={resultAnnounce}
                        onChange={(e) => setResultAnnounce(e.target.value)}
                        min={evtEnd || undefined}
                        required
                        className="form-input"
                        aria-invalid={resultAnnouncementError ? true : undefined}
                        aria-describedby={
                          resultAnnouncementError
                            ? "result-announcement-hint result-announcement-timeline-error"
                            : "result-announcement-hint"
                        }
                      />
                      {resultAnnouncementError ? (
                        <span
                          className="form-error"
                          id="result-announcement-timeline-error"
                          role="alert"
                        >
                          {resultAnnouncementError}
                        </span>
                      ) : null}
                    </label>
                    <p className="form-field-aside" id="result-announcement-hint">
                      Wajib diisi sebelum kompetisi diterbitkan agar peserta tahu kapan hasil
                      keluar.
                    </p>
                  </div>
                </div>
              </section>
            ) : null}

            {activeStep === null ? (
              <fieldset className="content-section competition-policy-fieldset">
                {minimumParticipationHeading}
                {minimumParticipationHelp}
                <div className="form-grid">
                  {minimumEntriesField}
                  {participantConfirmationField}
                </div>
                {participantConfirmationHelp}
              </fieldset>
            ) : null}
            {activeStep === 2 ? (
              <fieldset className="content-section competition-policy-fieldset">
                {minimumParticipationHeading}
                {minimumParticipationHelp}
                <div className="form-grid">{minimumEntriesField}</div>
              </fieldset>
            ) : null}
            {activeStep === 3 ? (
              <fieldset className="content-section competition-policy-fieldset">
                {minimumParticipationHeading}
                {isPublished ? minimumParticipationHelp : null}
                <div className="form-grid">{participantConfirmationField}</div>
                {participantConfirmationHelp}
              </fieldset>
            ) : null}

            {showsStep(4) ? (
              <fieldset className="content-section competition-policy-fieldset">
                <legend className="sr-only">Kebijakan pembatalan peserta</legend>
                <div className="section-heading">
                  <div>
                    <h2>Kebijakan pembatalan peserta</h2>
                  </div>
                </div>
                <CheckboxField
                  checked={allowCancellation}
                  onChange={(e) => setAllowCancellation(e.target.checked)}
                  disabled={cancellationRightIsLocked}
                  aria-describedby={
                    cancellationRightIsLocked ? "allow-cancellation-lock" : undefined
                  }
                >
                  Izinkan peserta membatalkan pendaftaran sendiri
                </CheckboxField>
                {cancellationRightIsLocked ? (
                  <p className="form-help" id="allow-cancellation-lock">
                    {PUBLISH_LOCK_REASONS.allowCancellation}
                  </p>
                ) : null}
                <label className="form-field">
                  <span className="form-label">Batas pembatalan (hari sebelum acara mulai)</span>
                  <input
                    type="number"
                    value={cutoffDays}
                    onChange={(e) => setCutoffDays(e.target.value)}
                    min={0}
                    max={savedCutoffDays ?? undefined}
                    disabled={!allowCancellation}
                    className="form-input"
                    aria-invalid={
                      brokenPublishLocks.includes("cancellationCutoffDays") ? true : undefined
                    }
                    aria-describedby={
                      cancellationRightIsLocked ? "cancellation-cutoff-lock" : undefined
                    }
                  />
                  {cancellationRightIsLocked ? (
                    <PublishLockLine
                      id="cancellation-cutoff-lock"
                      field="cancellationCutoffDays"
                      brokenLocks={brokenPublishLocks}
                    />
                  ) : null}
                </label>
              </fieldset>
            ) : null}
          </fieldset>
        </form>
      )}

      {activeStep === 5 ? stepSummarySections : null}

      <CompetitionEditorPartsContext.Provider value={reportEditorPart}>
        {editorPartsNode === null || editorPartsNode === undefined ? null : (
          <fieldset
            className="competition-editor-parts"
            role="none"
            disabled={!isEditable || isSubmitting}
          >
            {editorPartsNode}
          </fieldset>
        )}
      </CompetitionEditorPartsContext.Provider>

      {!isDraftStep ? (
        <FormActionBar>
          <IconButton icon="arrow-left" label="Kembali ke aksi status" onClick={handleBack} />
          {isEditable ? (
            <div className="form-action-bar-end">
              {publishReadinessNote}
              <Button
                type="button"
                onClick={() => onSaveSection()}
                loading={isSubmitting}
                disabled={isSubmitting || timelineIsInvalid || publishLockIsBroken}
                leadingIcon={<Icon name="save" />}
              >
                Simpan
              </Button>
              {isDraft ? (
                <Button
                  variant="outline"
                  type="button"
                  onClick={onPublish}
                  loading={isPublishing}
                  disabled={isSubmitting || publishIsBlocked}
                  aria-describedby="publish-readiness-message"
                >
                  Terbitkan
                </Button>
              ) : null}
            </div>
          ) : null}
        </FormActionBar>
      ) : (
        <FormActionBar>
          <IconButton
            icon="arrow-left"
            label={activeStep === 1 ? "Kembali ke daftar kompetisi" : "Kembali"}
            onClick={handleBack}
          />
          <div className="form-action-bar-end">
            {publishReadinessNote}
            {activeStep === 5 ? (
              <>
                <ButtonLink href={listHref} variant="ghost">
                  Keluar
                </ButtonLink>
                <Button
                  type="button"
                  onClick={onPublishAndOpenManagement}
                  loading={isPublishing}
                  disabled={isSubmitting || publishIsBlocked}
                  aria-describedby="publish-readiness-message"
                >
                  Terbitkan
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  type="button"
                  onClick={onSaveAndExit}
                  loading={pendingStepAction === "exit"}
                  disabled={isSubmitting}
                >
                  Simpan dan keluar
                </Button>
                <Button
                  type="button"
                  onClick={onNextStep}
                  loading={pendingStepAction === "next"}
                  disabled={isSubmitting}
                >
                  Lanjut
                </Button>
              </>
            )}
          </div>
        </FormActionBar>
      )}
    </main>
  );
};
