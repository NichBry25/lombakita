import QRCode from "qrcode";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/mfa/otpauth-qr");

// Renders an otpauth:// URI as a PNG data URI for an <img>. Generated on the server and inlined, so
// the secret never travels to a third-party chart service and the page needs no client-side script
// and no network request to display it.
//
// The colours are deliberately pure black on pure white rather than brand tokens, and this is the one
// place in the app where that is correct: the output is a machine-readable image, not themed chrome.
// Camera decoders threshold the image, so maximum luminance separation is a scan-reliability
// requirement — and a white quiet zone is mandated by the QR spec itself (ISO/IEC 18004), which is
// why the margin is kept rather than trimmed to zero. Tinting the modules to Deep Palm would still
// clear contrast on paper but buys nothing here and costs reliability on cheap scanners.
//
// Error correction M (~15% recoverable) is the standard choice for a screen-displayed code: H would
// enlarge the matrix for damage tolerance that a monitor never needs.
export const renderOtpauthQrDataUrl = async (otpauthUri: string): Promise<string> => {
  return QRCode.toDataURL(otpauthUri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 240,
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
};
