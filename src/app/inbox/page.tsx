import Link from "next/link";
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

const formatDate = (value: Date): string =>
  value.toLocaleString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// Visual differentiation by kind is intentional (minimal proof): notifications, institution
// invites, and team invites get distinct left-border colours and a kind label.
const KIND_ACCENT: Record<InboxItem["kind"], string> = {
  notification: "#355795",
  institution_invite: "#7a5cff",
  team_invite: "#1f9d6b",
};

const KIND_LABEL: Record<InboxItem["kind"], string> = {
  notification: "Notifikasi",
  institution_invite: "Undangan Institusi",
  team_invite: "Undangan Tim",
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
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ marginBottom: "1.5rem" }}>
        Kotak Masuk{" "}
        <span style={{ fontSize: "0.6em", color: "#b00020", fontWeight: 400 }}>
          ({unreadCount} belum dibaca)
        </span>
      </h1>

      {items.length === 0 ? (
        <p style={{ color: "#777" }}>Belum ada notifikasi atau undangan.</p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          {items.map((item) => {
            const accent = KIND_ACCENT[item.kind];
            const isUnreadNotification = item.kind === "notification" && item.readAt === null;
            return (
              <li
                key={`${item.kind}:${item.id}`}
                style={{
                  padding: "0.75rem 1rem",
                  background: isUnreadNotification ? "#eef3fb" : "#f9f9f9",
                  borderRadius: 4,
                  borderLeft: `3px solid ${accent}`,
                }}
              >
                <div style={{ fontSize: "0.75em", color: accent, fontWeight: 600 }}>
                  {KIND_LABEL[item.kind]}
                </div>

                {item.kind === "notification" ? (
                  <div>
                    <div style={{ fontWeight: 600 }}>{item.title}</div>
                    <div style={{ color: "#444", marginTop: 4 }}>{item.body}</div>
                    <div style={{ marginTop: 6, fontSize: "0.8em", color: "#888" }}>
                      {formatDate(item.createdAt)}
                    </div>
                    <div style={{ marginTop: 6, display: "flex", gap: 12, alignItems: "center" }}>
                      {isUnreadNotification ? (
                        <MarkReadButton
                          notificationId={item.id}
                          expectedUserId={session.user.id}
                        />
                      ) : null}
                      <DeleteNotificationButton
                        notificationId={item.id}
                        expectedUserId={session.user.id}
                      />
                    </div>
                  </div>
                ) : item.kind === "institution_invite" ? (
                  <div>
                    <div style={{ fontWeight: 600 }}>{item.institutionName}</div>
                    <div style={{ color: "#444", marginTop: 4 }}>Peran: {item.invitedRole}</div>
                    <div style={{ marginTop: 6, fontSize: "0.8em", color: "#888" }}>
                      Kedaluwarsa: {formatDate(item.expiresAt)}
                    </div>
                    <InboxInviteActions
                      kind="institution"
                      invitationId={item.id}
                      expectedUserId={session.user.id}
                    />
                  </div>
                ) : (
                  <div>
                    <div style={{ fontWeight: 600 }}>{item.teamName}</div>
                    <div style={{ color: "#444", marginTop: 4 }}>
                      Kompetisi: {item.competitionTitle}
                    </div>
                    <div style={{ marginTop: 6, fontSize: "0.8em", color: "#888" }}>
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

      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/" style={{ color: "#355795", fontSize: "0.9em" }}>
          ← Beranda
        </Link>
      </p>
    </main>
  );
}
