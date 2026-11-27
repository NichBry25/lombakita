// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SecondRolePromptModal, SHOW_SECOND_ROLE_PROMPT_EVENT } from "./second-role-prompt-modal";
import { UIPrimitivesProvider, useModal } from "@/components/ui/primitives";
import { VerifyOtherRoleButton } from "@/app/profile/verify-other-role-button";

const mocks = vi.hoisted(() => {
  const push = vi.fn();
  return {
    session: {
      current: {
        data: { user: { id: "u1", role: "recruiter", verifiedRoles: ["recruiter"] } },
        status: "authenticated",
      } as {
        data: { user: { id: string; role: string; verifiedRoles: string[] } } | null;
        status: string;
      },
    },
    push,
    router: { push },
  };
});

vi.mock("next-auth/react", () => ({ useSession: () => mocks.session.current }));
// One router object for the whole file, as the app router gives. A new object on every render
// would make the pop-up's opening effect run again on every render, without end.
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));

const signInAs = (role: string, verifiedRoles: string[]) => {
  mocks.session.current = {
    data: { user: { id: "u1", role, verifiedRoles } },
    status: "authenticated",
  };
};

const openFromProfileButton = () => {
  act(() => {
    window.dispatchEvent(new Event(SHOW_SECOND_ROLE_PROMPT_EVENT));
  });
};

const popUpOnly = () => (
  <UIPrimitivesProvider>
    <SecondRolePromptModal />
  </UIPrimitivesProvider>
);

const popUpBesideProfileButton = () => (
  <UIPrimitivesProvider>
    <VerifyOtherRoleButton label="Verifikasi sebagai Kandidat" />
    <SecondRolePromptModal />
  </UIPrimitivesProvider>
);

const AnotherModalOpener = () => {
  const { openModal } = useModal();
  return (
    <button
      type="button"
      onClick={() => openModal({ title: "Pangkas foto", body: "Atur bagian foto.", actions: [] })}
    >
      Buka modal lain
    </button>
  );
};

const pressProfileButton = (): HTMLElement => {
  const profileButton = screen.getByRole("button", { name: "Verifikasi sebagai Kandidat" });
  act(() => profileButton.focus());
  fireEvent.click(profileButton);
  return profileButton;
};

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });

afterEach(() => {
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe("the second role pop-up", () => {
  it("never opens on its own, whatever this tab holds", () => {
    signInAs("recruiter", ["recruiter"]);
    window.sessionStorage.setItem("lombakita:second-role-prompt:pending", "1");

    render(popUpOnly());

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from the profile button's event and offers the participant role to a host", () => {
    signInAs("recruiter", ["recruiter"]);
    render(popUpOnly());

    openFromProfileButton();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Verifikasi akun kandidat Anda");
    expect(dialog.textContent).toContain(
      "Akun Anda saat ini hanya terverifikasi sebagai penyelenggara. Verifikasi sebagai kandidat untuk dapat mengikuti kompetisi.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Verifikasi sebagai kandidat" }));
    expect(mocks.push).toHaveBeenCalledWith("/auth/verify-role?as=candidate");
  });

  it("offers a participant the host step", () => {
    signInAs("candidate", ["candidate"]);
    render(popUpOnly());

    openFromProfileButton();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Mulai menyelenggarakan kompetisi");
    expect(dialog.textContent).toContain(
      "Akun Anda saat ini hanya untuk mengikuti kompetisi. Tambahkan peran penyelenggara untuk membuat dan menerbitkan kompetisi.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Mulai menyelenggarakan" }));
    expect(mocks.push).toHaveBeenCalledWith("/auth/verify-role?as=recruiter");
  });

  it("offers nothing to an operational account", () => {
    const opened: Record<string, boolean> = {};
    for (const role of ["platform_ops", "finance_ops", "reviewer_or_judge"]) {
      signInAs(role, ["candidate"]);
      const { unmount } = render(popUpOnly());
      openFromProfileButton();
      opened[role] = screen.queryByRole("dialog") !== null;
      unmount();
    }

    expect(opened).toEqual({ platform_ops: false, finance_ops: false, reviewer_or_judge: false });
  });

  it("opens once the session has loaded when the profile button was pressed while it loaded", () => {
    mocks.session.current = { data: null, status: "loading" };
    const { rerender } = render(popUpBesideProfileButton());
    pressProfileButton();
    const openWhileLoading = screen.queryByRole("dialog") !== null;
    signInAs("recruiter", ["recruiter"]);
    rerender(popUpBesideProfileButton());

    expect({ openWhileLoading, openAfterLoad: screen.queryByRole("dialog") !== null }).toEqual({
      openWhileLoading: false,
      openAfterLoad: true,
    });
  });

  it("closes the open pop-up when the session in this tab turns into an operational account", () => {
    signInAs("recruiter", ["recruiter"]);
    const { rerender } = render(popUpBesideProfileButton());
    pressProfileButton();
    const openBefore = screen.queryByRole("dialog") !== null;
    signInAs("platform_ops", ["candidate"]);
    rerender(popUpBesideProfileButton());

    expect({ openBefore, openAfter: screen.queryByRole("dialog") !== null }).toEqual({
      openBefore: true,
      openAfter: false,
    });
  });

  it("keeps another component's modal open when the session changes while the pop-up is shut", () => {
    signInAs("recruiter", ["recruiter"]);
    const tree = () => (
      <UIPrimitivesProvider>
        <AnotherModalOpener />
        <SecondRolePromptModal />
      </UIPrimitivesProvider>
    );
    const { rerender } = render(tree());
    fireEvent.click(screen.getByRole("button", { name: "Buka modal lain" }));
    const openBefore = screen.queryByRole("dialog") !== null;
    signInAs("platform_ops", ["candidate"]);
    rerender(tree());

    expect({ openBefore, openAfter: screen.queryByRole("dialog") !== null }).toEqual({
      openBefore: true,
      openAfter: true,
    });
  });
});

describe("the second role pop-up from the keyboard", () => {
  it("moves focus into the pop-up when the profile button opens it", () => {
    signInAs("recruiter", ["recruiter"]);
    render(popUpBesideProfileButton());
    pressProfileButton();
    const dialog = screen.queryByRole("dialog");

    expect({
      open: dialog !== null,
      focusInside: dialog?.contains(document.activeElement) ?? false,
    }).toEqual({ open: true, focusInside: true });
  });

  it("keeps Tab inside the pop-up", () => {
    signInAs("recruiter", ["recruiter"]);
    render(popUpBesideProfileButton());
    pressProfileButton();
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button");
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    act(() => last.focus());
    press("Tab");
    const afterTabFromLast = document.activeElement;
    act(() => first.focus());
    press("Tab", { shiftKey: true });
    const afterShiftTabFromFirst = document.activeElement;

    expect({
      tabFromLastLandsOnFirst: afterTabFromLast === first,
      shiftTabFromFirstLandsOnLast: afterShiftTabFromFirst === last,
    }).toEqual({ tabFromLastLandsOnFirst: true, shiftTabFromFirstLandsOnLast: true });
  });

  it("closes the pop-up on Escape without leaving the page", () => {
    signInAs("recruiter", ["recruiter"]);
    render(popUpBesideProfileButton());
    pressProfileButton();
    press("Escape");

    expect({
      open: screen.queryByRole("dialog") !== null,
      pushed: mocks.push.mock.calls,
    }).toEqual({ open: false, pushed: [] });
  });

  it("returns focus to the profile button when the pop-up closes", () => {
    signInAs("recruiter", ["recruiter"]);
    render(popUpBesideProfileButton());
    const profileButton = pressProfileButton();
    const dialog = screen.getByRole("dialog");
    const focusInsideWhileOpen = dialog.contains(document.activeElement);
    fireEvent.click(within(dialog).getByRole("button", { name: "Nanti saja" }));

    expect({
      focusInsideWhileOpen,
      open: screen.queryByRole("dialog") !== null,
      focusOnProfileButton: document.activeElement === profileButton,
    }).toEqual({ focusInsideWhileOpen: true, open: false, focusOnProfileButton: true });
  });

  it("opens again when the profile button is pressed after the pop-up was closed", () => {
    signInAs("recruiter", ["recruiter"]);
    render(popUpBesideProfileButton());
    pressProfileButton();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Nanti saja" }));
    pressProfileButton();

    expect({ openAfterSecondPress: screen.queryByRole("dialog") !== null }).toEqual({
      openAfterSecondPress: true,
    });
  });
});
