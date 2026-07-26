import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import {
  countUnreadInboxItems,
  listUserInbox,
  type InboxItem,
} from "@/server/notifications/inbox-service";
import { MarkReadButton } from "./mark-read-button";
import { DeleteNotificationButton } from "./delete-notification-button";
import { InboxInviteActions } from "./invite-actions";
import { ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { getInstitutionRoleLabel } from "@/lib/access/role-labels";

const formatDate = (value: Date): string =>
  value.toLocaleString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const KIND_LABEL: Record<InboxItem["kind"], string> = {
  notification: "Notifikasi",
  institution_invite: "Undangan institusi",
  team_invite: "Undangan tim",
};

export default async function InboxPage() {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/inbox");
  }

  const db = getDb();
  const [items, unreadCount] = await Promise.all([
    listUserInbox(session.user.id, db),
    countUnreadInboxItems(session.user.id, db),
  ]);

  return (
    <main className="page-shell app-page inbox-page">
      <PageHeader
        eyebrow="Pusat komunikasi"
        title="Kotak masuk"
        description="Notifikasi dan undangan penting tersusun dalam satu alur tindakan."
        actions={<span className="inbox-unread-count data-text">{unreadCount} belum dibaca</span>}
      />

      {items.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="Kotak masuk masih tenang."
          description="Notifikasi, undangan institusi, dan undangan tim akan muncul di sini."
          action={
            <ButtonLink href="/" variant="outline">
              Kembali
            </ButtonLink>
          }
        />
      ) : (
        <ul className="inbox-list">
          {items.map((item) => {
            const isUnreadNotification = item.kind === "notification" && item.readAt === null;
            return (
              <li
                key={`${item.kind}:${item.id}`}
                className="inbox-card"
                data-kind={item.kind}
                data-unread={isUnreadNotification ? "true" : undefined}
              >
                <div className="inbox-kind-label">{KIND_LABEL[item.kind]}</div>

                {item.kind === "notification" ? (
                  <div className="inbox-card-content">
                    <h2>{item.title}</h2>
                    <p>{item.body}</p>
                    <div className="inbox-date data-text">{formatDate(item.createdAt)}</div>
                    <div className="inbox-actions">
                      {isUnreadNotification ? (
                        <MarkReadButton notificationId={item.id} expectedUserId={session.user.id} />
                      ) : null}
                      <DeleteNotificationButton
                        notificationId={item.id}
                        expectedUserId={session.user.id}
                      />
                    </div>
                  </div>
                ) : item.kind === "institution_invite" ? (
                  <div className="inbox-card-content">
                    <h2>{item.institutionName}</h2>
                    <p>Peran: {getInstitutionRoleLabel(item.invitedRole)}</p>
                    <div className="inbox-date data-text">
                      Kedaluwarsa: {formatDate(item.expiresAt)}
                    </div>
                    <InboxInviteActions
                      kind="institution"
                      invitationId={item.id}
                      expectedUserId={session.user.id}
                    />
                  </div>
                ) : (
                  <div className="inbox-card-content">
                    <h2>{item.teamName}</h2>
                    <p>Kompetisi: {item.competitionTitle}</p>
                    <div className="inbox-date data-text">
                      Kedaluwarsa: {formatDate(item.expiresAt)}
                    </div>
                    <InboxInviteActions
                      kind="team"
                      invitationId={item.id}
                      expectedUserId={session.user.id}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
