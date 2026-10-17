import { ButtonLink } from "@/components/ui";

type ResetLinkErrorStateProps = {
  title: string;
  description?: string;
};

export function ResetLinkErrorState({ title, description }: ResetLinkErrorStateProps) {
  return (
    <div className="auth-state stack-md">
      <span className="auth-state-icon" data-tone="error" aria-hidden="true">
        !
      </span>
      <div className="stack-xs">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <ButtonLink variant="primary" size="md" href="/auth/forgot-password">
        Minta tautan baru
      </ButtonLink>
    </div>
  );
}
