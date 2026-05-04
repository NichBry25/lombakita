import { InvitationAcceptShell } from "@/components/invitation/invitation-accept-shell";

type InvitationAcceptPageProps = {
  params: Promise<{ token: string }>;
};

export default async function InvitationAcceptPage({ params }: InvitationAcceptPageProps) {
  const { token } = await params;
  return <InvitationAcceptShell token={token} />;
}
