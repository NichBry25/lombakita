import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockAddToast, mockPush, mockReplace, mockSessionFetch } = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  mockSessionFetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
}));
vi.mock("@/components/ui", () => ({
  Button: ({
    children,
    loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button data-loading={loading ? "true" : undefined} {...props}>
      {children}
    </button>
  ),
  ButtonLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  FormActionBar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  IconButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  usePageTransition: () => ({
    begin: vi.fn(),
    end: vi.fn(),
    runAndNavigate: (action: () => Promise<boolean>) => action(),
  }),
}));
vi.mock("@/components/ui/primitives", () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));
vi.mock("@/lib/session/session-fetch", () => ({
  readErrorCode: vi.fn(),
  SESSION_MISMATCH_CODE: "session_mismatch",
  SESSION_MISMATCH_MESSAGE: "Session mismatch",
  sessionFetch: mockSessionFetch,
}));

import { PersonalInstitutionCreateShell } from "@/components/institution/personal-institution-create-shell";

describe("PersonalInstitutionCreateShell", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens a new competition draft after creating the personal workspace", async () => {
    mockSessionFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          institution: {
            institutionId: "institution_personal",
            displayName: "owner_username's Institution",
            slug: "owner-username",
            status: "inactive",
            institutionType: "personal",
            createdAt: "2026-07-23T00:00:00.000Z",
            updatedAt: "2026-07-23T00:00:00.000Z",
          },
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    render(<PersonalInstitutionCreateShell expectedUserId="user_recruiter" />);
    fireEvent.click(screen.getByRole("button", { name: "Mulai menyelenggarakan" }));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/institution/owner-username/competitions/new");
    });
    expect(mockSessionFetch).toHaveBeenCalledWith(
      "user_recruiter",
      "/api/v1/institutions/personal",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
