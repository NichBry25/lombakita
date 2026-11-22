import type { ParticipantRecord } from "@/server/participants/participant-service";

const PENDING_EMAIL_INVITE_LABEL = "Undangan ke email, belum punya akun";

// The detail band of a team row: joined members, then the teammates who have not joined. An invite
// to an email without an account carries no address, so none can be shown.
export function ParticipantTeamMembers({ team }: { team: NonNullable<ParticipantRecord["team"]> }) {
  return (
    <ul className="ui-table-member-list">
      {team.members.map((m) => (
        <li key={m.userId}>
          {m.displayName ?? m.username}
          {m.isCaptain ? " (Kapten)" : ""}
        </li>
      ))}
      {team.pendingTeammates.map((t) => (
        <li key={t.invitationId} className="muted-copy">
          {t.username === null ? PENDING_EMAIL_INVITE_LABEL : `${t.username} (belum bergabung)`}
        </li>
      ))}
    </ul>
  );
}
