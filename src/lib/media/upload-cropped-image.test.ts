// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadCroppedImage } from "./upload-cropped-image";

const fetchMock = vi.fn();

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("asks for the presigned address at the upload-url path under the base path", async () => {
  const rules = { mimeTypes: ["image/png"], maxBytes: 1000 };
  const file = new File(["x"], "logo.png", { type: "image/png" });
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse(201, {
        uploadUrl: "https://upload.example.test/put",
        fileKey: "institution-logos/inst_1/key",
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(jsonResponse(200, {}));

  await uploadCroppedImage("user-42", "/api/v1/institutions/academy/profile/logo", rules, file);

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/v1/institutions/academy/profile/logo/upload-url",
    expect.objectContaining({ method: "POST" }),
  );
});
