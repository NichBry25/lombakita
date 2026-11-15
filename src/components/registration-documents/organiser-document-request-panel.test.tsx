// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import {
  OrganiserDocumentRequestPanel,
  type OrganiserDocumentRequest,
} from "./organiser-document-request-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const REQUEST: OrganiserDocumentRequest = {
  id: "req-1",
  title: "Kartu pelajar",
  instructions: null,
  dueAt: "2030-01-01T00:00:00.000Z",
  status: "submitted",
  displayStatus: "submitted",
  isOverdue: false,
  isLate: false,
  reviewNote: null,
  revisionCount: 0,
  files: [],
};

const REQUEST_URL = "/api/v1/institutions/inst-1/competitions/comp-1/document-requests/req-1";

const renderPanel = () =>
  render(
    <UIPrimitivesProvider>
      <OrganiserDocumentRequestPanel
        institutionSlug="inst-1"
        competitionId="comp-1"
        registrationId="reg-1"
        requests={[REQUEST]}
      />
    </UIPrimitivesProvider>,
  );

const stubNetwork = () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const openPopUp = (openerName: string) => {
  fireEvent.click(screen.getByRole("button", { name: openerName }));
  return screen.getByRole("dialog");
};

const press = async (dialog: HTMLElement, name: string) =>
  act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name }));
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the reject pop-up of a document request", () => {
  it("shows the note error after the first press and sends nothing when the note is empty", async () => {
    const fetchMock = stubNetwork();
    renderPanel();
    const dialog = openPopUp("Tolak");
    expect(within(dialog).queryByText("Alasan penolakan wajib diisi.")).toBeNull();

    await press(dialog, "Tolak dokumen");

    expect(within(dialog).getByText("Alasan penolakan wajib diisi.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a note of spaces as empty and sends nothing", async () => {
    const fetchMock = stubNetwork();
    renderPanel();
    const dialog = openPopUp("Tolak");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Alasan penolakan/ }), {
      target: { value: "     " },
    });

    await press(dialog, "Tolak dokumen");

    expect(within(dialog).getByText("Alasan penolakan wajib diisi.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the deadline error and sends nothing when a reopening rejection has no deadline", async () => {
    const fetchMock = stubNetwork();
    renderPanel();
    const dialog = openPopUp("Tolak");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Alasan penolakan/ }), {
      target: { value: "Foto buram" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Tenggat baru/), { target: { value: "" } });

    await press(dialog, "Tolak dokumen");

    expect(within(dialog).getByText("Tenggat wajib diisi.")).toBeTruthy();
    expect(within(dialog).queryByText("Alasan penolakan wajib diisi.")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the trimmed note and a deadline once both are valid", async () => {
    const fetchMock = stubNetwork();
    renderPanel();
    const dialog = openPopUp("Tolak");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Alasan penolakan/ }), {
      target: { value: "  Foto buram  " },
    });
    fireEvent.change(within(dialog).getByLabelText(/Tenggat baru/), {
      target: { value: "2031-02-03T04:05" },
    });

    await press(dialog, "Tolak dokumen");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REQUEST_URL);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      action: "review",
      verdict: "reject",
      note: "Foto buram",
      allowReupload: true,
    });
    expect(body.dueAt).toBe(new Date("2031-02-03T04:05").toISOString());
  });
});

describe("the extend-deadline pop-up of a document request", () => {
  it("shows the deadline error after the first press and sends nothing when the deadline is empty", async () => {
    const fetchMock = stubNetwork();
    renderPanel();
    const dialog = openPopUp("Perpanjang tenggat");
    fireEvent.change(within(dialog).getByLabelText(/Tenggat baru/), { target: { value: "" } });
    expect(within(dialog).queryByText("Tenggat wajib diisi.")).toBeNull();

    await press(dialog, "Perpanjang");

    expect(within(dialog).getByText("Tenggat wajib diisi.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the new deadline once it is valid", async () => {
    const fetchMock = stubNetwork();
    renderPanel();
    const dialog = openPopUp("Perpanjang tenggat");
    fireEvent.change(within(dialog).getByLabelText(/Tenggat baru/), {
      target: { value: "2031-02-03T04:05" },
    });

    await press(dialog, "Perpanjang");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REQUEST_URL);
    expect(JSON.parse(init.body as string)).toEqual({
      action: "extend",
      dueAt: new Date("2031-02-03T04:05").toISOString(),
    });
  });
});
