import { sameSitePathOr } from "@/lib/session/return-path";

// The auth library drops callbackUrl when it sends a new Google user to the role picker, so the
// page this tab started from waits here until the role picker finishes the sign-up.
export const GOOGLE_RETURN_PATH_KEY = "lombakita:google-sign-up:return-path";

export const rememberGoogleReturnPath = (returnPath: string | undefined): void => {
  try {
    if (typeof returnPath === "string" && returnPath.length > 0) {
      window.sessionStorage.setItem(GOOGLE_RETURN_PATH_KEY, returnPath);
    } else {
      window.sessionStorage.removeItem(GOOGLE_RETURN_PATH_KEY);
    }
  } catch {
    // sessionStorage unavailable: the sign-up then returns to the home page.
  }
};

// Checked here, where the value is used, because anything in this tab can write the key.
export const readGoogleReturnPath = (): string => {
  let stored: string | null;
  try {
    stored = window.sessionStorage.getItem(GOOGLE_RETURN_PATH_KEY);
  } catch {
    stored = null;
  }
  return sameSitePathOr(stored, "/");
};
