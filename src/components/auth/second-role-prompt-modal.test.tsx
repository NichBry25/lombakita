// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SecondRolePromptModal, SHOW_SECOND_ROLE_PROMPT_EVENT } from "./second-role-prompt-modal";

const mocks = vi.hoisted(() => ({
  session: {
    current: {
      data: { user: { id: "u1", role: "recruiter", verifiedRoles: ["recruiter"] } },
      status: "authenticated",
    } as {
      data: { user: { id: string; role: string; verifiedRoles: string[] } };
      status: string;
    },
  },
  push: vi.fn(),
}));

vi.mock("next-auth/react", () => ({ useSession: () => mocks.session.current }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

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

afterEach(() => {
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe("the second role pop-up", () => {
  it("never opens on its own, whatever this tab holds", () => {
    signInAs("recruiter", ["recruiter"]);
    window.sessionStorage.setItem("lombakita:second-role-prompt:pending", "1");

    render(<SecondRolePromptModal />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from the profile button's event and offers the participant role to a host", () => {
    signInAs("recruiter", ["recruiter"]);
    render(<SecondRolePromptModal />);

    openFromProfileButton();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Verifikasi akun kandidat Anda");
    expect(dialog.textContent).toContain(
      "Akun Anda saat ini hanya terverifikasi sebagai penyelenggara. Verifikasi sebagai kandidat untuk dapat mengikuti kompetisi.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Verifikasi sebagai kandidat" }));
    expect(mocks.push).toHaveBeenCalledWith("/auth/verify-role?as=candidate");
  });

  it("names the host role penyelenggara for a participant", () => {
    signInAs("candidate", ["candidate"]);
    render(<SecondRolePromptModal />);

    openFromProfileButton();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Verifikasi akun penyelenggara Anda");
    expect(dialog.textContent).toContain(
      "Akun Anda saat ini hanya terverifikasi sebagai kandidat. Verifikasi sebagai penyelenggara untuk dapat memposting peluang.",
    );
    expect(screen.getByRole("button", { name: "Verifikasi sebagai penyelenggara" })).toBeTruthy();
  });

  it("offers nothing to an operational account", () => {
    signInAs("platform_ops", []);
    render(<SecondRolePromptModal />);

    openFromProfileButton();

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
