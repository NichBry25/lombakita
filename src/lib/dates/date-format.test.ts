// @vitest-environment node
import { describe, expect, it } from "vitest";
import { WIB_TIME_ZONE, formatDateIn, formatWib, formatWibDateStamp } from "./date-format";

describe("date formats", () => {
  it("prints a WIB evening deadline on its own day and time", () => {
    expect(formatWib("2026-11-20T16:30:00Z", "longDateTime")).toBe("20 November 2026 pukul 23.30");
  });

  it("prints the same instant in another zone when asked", () => {
    expect(formatDateIn("2026-11-20T16:30:00Z", "longDateTime", "Asia/Makassar")).toBe(
      "21 November 2026 pukul 00.30",
    );
  });

  it("capitalises the finance separator", () => {
    expect(formatWib("2026-11-20T16:30:00Z", "financeDateTime")).toBe(
      "20 November 2026 Pukul 23.30",
    );
  });

  it("prints the WIB calendar day of an instant that is still the day before in UTC", () => {
    expect(formatWib("2026-11-20T18:30:00Z", "longDate")).toBe("21 November 2026");
  });

  it("stamps a file name with the WIB date", () => {
    expect(formatWibDateStamp(new Date("2026-11-20T18:30:00Z"))).toBe("2026-11-21");
  });

  it("shows a dash for an unreadable date", () => {
    expect(formatWib("not a date", "longDate")).toBe("—");
  });

  it("names the zone it formats emails in", () => {
    expect(WIB_TIME_ZONE).toBe("Asia/Jakarta");
  });

  it("prints every format in WIB", () => {
    const value = "2026-11-20T16:30:00Z";
    expect(formatWib(value, "numericDate")).toBe("20/11/2026");
    expect(formatWib(value, "numericDateTime")).toBe("20/11/2026, 23.30.00");
    expect(formatWib(value, "shortDate")).toBe("20 Nov 2026");
    expect(formatWib(value, "longDate")).toBe("20 November 2026");
    expect(formatWib(value, "longDateTime")).toBe("20 November 2026 pukul 23.30");
    expect(formatWib(value, "dayMonth")).toBe("20 November");
    expect(formatWib(value, "dayMonthShort")).toBe("20 Nov");
    expect(formatWib(value, "financeDateTime")).toBe("20 November 2026 Pukul 23.30");
  });
});
