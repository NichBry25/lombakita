// @vitest-environment jsdom

import { render, screen, act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModalProvider, useModal } from "./modal-context";
import { Modal } from "./modal";

// Renders the provider + the Modal surface, and exposes openModal to the test via a trigger button
// so focus restoration has a real trigger to return to.
function Harness({
  onReady,
}: {
  onReady: (open: ReturnType<typeof useModal>["openModal"]) => void;
}) {
  const { openModal } = useModal();
  return (
    <button type="button" data-testid="trigger" onClick={() => onReady(openModal)}>
      Open
    </button>
  );
}

function renderModal(): { openModal: ReturnType<typeof useModal>["openModal"] } {
  let captured: ReturnType<typeof useModal>["openModal"] | null = null;
  render(
    <ModalProvider>
      <Harness onReady={(open) => (captured = open)} />
      <Modal />
    </ModalProvider>,
  );
  // Click the trigger so it is the element focus should return to on close.
  const trigger = screen.getByTestId("trigger");
  act(() => trigger.focus());
  act(() => trigger.click());
  return { openModal: captured! };
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });

describe("Modal — accessibility", () => {
  it("moves focus into the dialog when it opens", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Konfirmasi",
        body: "Body",
        actions: [{ label: "Mengerti", variant: "primary" }],
      }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape when it has no actions of its own", () => {
    const { openModal } = renderModal();
    act(() => openModal({ title: "Konfirmasi", body: "Body", actions: [] }));
    expect(screen.queryByRole("dialog")).not.toBeNull();

    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has no close button on any pop-up", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Konfirmasi",
        body: "Body",
        actions: [{ label: "Batal" }, { label: "Lanjut", variant: "primary" }],
      }),
    );

    expect(screen.queryByRole("button", { name: "Tutup" })).toBeNull();
  });

  it("uses role alertdialog for a destructive confirm and dialog otherwise", () => {
    const { openModal } = renderModal();
    act(() => openModal({ title: "Hapus?", body: "Body", alert: true, actions: [] }));
    expect(screen.queryByRole("alertdialog")).not.toBeNull();

    act(() => openModal({ title: "Info", body: "Body", actions: [] }));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("points aria-labelledby at the title and aria-describedby at the body", () => {
    const { openModal } = renderModal();
    act(() => openModal({ title: "Judul", body: "Isi pop-up", actions: [] }));

    const dialog = screen.getByRole("dialog");
    const title = document.getElementById(dialog.getAttribute("aria-labelledby")!);
    const body = document.getElementById(dialog.getAttribute("aria-describedby")!);
    expect(title?.textContent).toBe("Judul");
    expect(body?.textContent).toBe("Isi pop-up");
  });

  it("makes the page behind inert while open and restores it on close", () => {
    const { openModal } = renderModal();
    const pageRoot = screen.getByTestId("trigger").parentElement!;
    expect(pageRoot.hasAttribute("inert")).toBe(false);

    act(() => openModal({ title: "Konfirmasi", body: "Body", actions: [] }));
    const dialogRoot = screen.getByRole("dialog").closest(".modal-backdrop")!;
    expect(pageRoot.hasAttribute("inert")).toBe(true);
    expect(dialogRoot.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");

    press("Escape");
    expect(pageRoot.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("restores focus to the trigger when the dialog closes", () => {
    const { openModal } = renderModal();
    const trigger = screen.getByTestId("trigger");

    act(() => openModal({ title: "Konfirmasi", body: "Body", actions: [] }));
    expect(document.activeElement).not.toBe(trigger);

    press("Escape");
    expect(document.activeElement).toBe(trigger);
  });

  it("wraps focus from the last focusable back to the first on Tab", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Konfirmasi",
        body: "Body",
        actions: [
          { label: "Batal", onClick: () => {} },
          { label: "Lanjut", onClick: () => {} },
        ],
      }),
    );

    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>("button");
    const last = focusables[focusables.length - 1]!;
    act(() => last.focus());
    expect(document.activeElement).toBe(last);

    press("Tab");
    // Focus wrapped back inside the dialog rather than escaping to the page.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });
});

describe("Modal — footer, focus and waiting", () => {
  it("starts focus on the safe choice of a destructive confirm", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Hapus?",
        body: "Body",
        alert: true,
        actions: [{ label: "Batal" }, { label: "Hapus", variant: "primary" }],
      }),
    );

    expect(document.activeElement?.textContent).toBe("Batal");
  });

  it("starts focus on the main action of a positive confirm and of an information pop-up", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Terima?",
        body: "Body",
        actions: [{ label: "Batal" }, { label: "Terima", variant: "primary" }],
      }),
    );
    expect(document.activeElement?.textContent).toBe("Terima");

    act(() =>
      openModal({
        title: "Info",
        body: "Body",
        actions: [{ label: "Mengerti", variant: "primary" }],
      }),
    );
    expect(document.activeElement?.textContent).toBe("Mengerti");
  });

  it("lets a pop-up choose the safe choice for focus even when it is a positive confirm", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Verifikasi?",
        body: "Body",
        initialFocus: "safe",
        actions: [{ label: "Batal" }, { label: "Verifikasi", variant: "primary" }],
      }),
    );

    expect(document.activeElement?.textContent).toBe("Batal");
  });

  it("puts the safe choice before the main action in one row", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Hapus?",
        body: "Body",
        actions: [{ label: "Hapus", variant: "primary" }, { label: "Batal" }],
      }),
    );

    const labels = Array.from(
      screen.getByRole("dialog").querySelectorAll(".modal-footer button"),
    ).map((button) => button.textContent);
    expect(labels).toEqual(["Batal", "Hapus"]);
    expect(
      screen.getByRole("dialog").querySelector(".modal-footer")?.getAttribute("data-layout"),
    ).toBe("row");
  });

  it("stacks a main action and two safe choices with the main action first", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Tim belum lengkap",
        body: "Body",
        actions: [
          { label: "Simpan dan keluar", variant: "primary" },
          { label: "Tetap di sini" },
          { label: "Keluar tanpa menyimpan" },
        ],
      }),
    );

    const footer = screen.getByRole("dialog").querySelector(".modal-footer")!;
    expect(footer.getAttribute("data-layout")).toBe("stack");
    const labels = Array.from(footer.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Simpan dan keluar", "Tetap di sini", "Keluar tanpa menyimpan"]);
  });

  it("does the first safe choice on Escape and closes", () => {
    const { openModal } = renderModal();
    const stay = vi.fn();
    const leave = vi.fn();
    act(() =>
      openModal({
        title: "Tim belum lengkap",
        body: "Body",
        actions: [
          { label: "Simpan dan keluar", variant: "primary" },
          { label: "Tetap di sini", onClick: stay },
          { label: "Keluar tanpa menyimpan", onClick: leave },
        ],
      }),
    );

    press("Escape");

    expect(stay).toHaveBeenCalledOnce();
    expect(leave).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("treats the one button of an information pop-up as the way out for Escape", async () => {
    const { openModal } = renderModal();
    const understood = vi.fn();
    act(() =>
      openModal({
        title: "Info",
        body: "Body",
        actions: [{ label: "Mengerti", variant: "primary", onClick: understood }],
      }),
    );

    press("Escape");

    expect(understood).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does the safe choice on a tap outside a confirm but not outside a pop-up with a field", () => {
    const { openModal } = renderModal();
    act(() => openModal({ title: "Hapus?", body: "Body", actions: [{ label: "Batal" }] }));
    act(() => {
      (screen.getByRole("dialog").parentElement as HTMLElement).click();
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() =>
      openModal({ title: "Formulir", body: "Body", wide: true, actions: [{ label: "Batal" }] }),
    );
    act(() => {
      (screen.getByRole("dialog").parentElement as HTMLElement).click();
    });
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("submits the form from the footer: the main button carries type submit and the form id", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Formulir",
        body: <form id="alasan-form" />,
        wide: true,
        formId: "alasan-form",
        actions: [{ label: "Batal" }, { label: "Kirim", variant: "primary" }],
      }),
    );

    const main = screen.getByRole("button", { name: "Kirim" });
    expect(main.getAttribute("type")).toBe("submit");
    expect(main.getAttribute("form")).toBe("alasan-form");
    expect((main as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays open while the main action runs, shows it is busy and ignores Escape", async () => {
    const { openModal } = renderModal();
    let finish: () => void = () => {};
    const task = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    act(() =>
      openModal({
        title: "Hapus?",
        body: "Body",
        actions: [{ label: "Batal" }, { label: "Hapus", variant: "primary", onClick: task }],
      }),
    );

    act(() => {
      screen.getByRole("button", { name: "Hapus" }).click();
    });

    const main = screen.getByRole("button", { name: "Hapus" });
    expect(main.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Batal" }).getAttribute("aria-disabled")).toBe(
      "true",
    );

    press("Escape");
    expect(screen.queryByRole("dialog")).not.toBeNull();

    await act(async () => finish());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a failure inside the pop-up as an alert and lets the main action try again", async () => {
    const { openModal } = renderModal();
    const task = vi
      .fn<() => Promise<{ ok: true } | { ok: false; message: string }>>()
      .mockResolvedValueOnce({ ok: false, message: "Koneksi terputus." })
      .mockResolvedValueOnce({ ok: true });
    act(() =>
      openModal({
        title: "Verifikasi?",
        body: "Body",
        actions: [{ label: "Batal" }, { label: "Verifikasi", variant: "primary", onClick: task }],
      }),
    );

    await act(async () => {
      screen.getByRole("button", { name: "Verifikasi" }).click();
    });

    expect(screen.getByRole("alert").textContent).toContain("Koneksi terputus.");
    expect(screen.queryByRole("dialog")).not.toBeNull();

    await act(async () => {
      screen.getByRole("button", { name: "Verifikasi" }).click();
    });

    expect(task).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
