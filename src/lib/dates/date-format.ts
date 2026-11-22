export const WIB_TIME_ZONE = "Asia/Jakarta";

type DateInput = Date | string | number;

type DateFormat = {
  options: Intl.DateTimeFormatOptions;
  withTime: boolean;
  finish?: (text: string) => string;
};

// The shapes the app shows dates in. A server component can hand a client component a name,
// never a function, so a site picks one of these instead of passing its own options.
const DATE_FORMATS = {
  numericDate: { options: {}, withTime: false },
  numericDateTime: { options: {}, withTime: true },
  shortDate: { options: { day: "numeric", month: "short", year: "numeric" }, withTime: false },
  shortDateTime: {
    options: {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
    withTime: true,
  },
  // The audit log keeps seconds so that events inside one minute stay in order.
  shortDateTimeSeconds: {
    options: {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    },
    withTime: true,
  },
  longDate: { options: { day: "numeric", month: "long", year: "numeric" }, withTime: false },
  longDateTime: {
    options: { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" },
    withTime: true,
  },
  dayMonth: { options: { day: "numeric", month: "long" }, withTime: false },
  dayMonthShort: { options: { day: "2-digit", month: "short" }, withTime: false },
  financeDateTime: {
    options: { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" },
    withTime: true,
    // A finance time is spelled out in full, never a relative phrase, because a transfer needs a
    // real date. Intl writes the separator in lower case; every other word the app shows in a
    // value position is capitalised, so this one is too.
    finish: (text) => text.replace(" pukul ", " Pukul "),
  },
} satisfies Record<string, DateFormat>;

export type DateFormatName = keyof typeof DATE_FORMATS;

// timeZone undefined means the zone of the device the code runs on.
export const formatDateIn = (
  value: DateInput,
  format: DateFormatName,
  timeZone: string | undefined,
): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const { options, withTime, finish } = DATE_FORMATS[format] as DateFormat;
  const zoned = { ...options, timeZone };
  const text = withTime
    ? date.toLocaleString("id-ID", zoned)
    : date.toLocaleDateString("id-ID", zoned);
  return finish ? finish(text) : text;
};

// Emails, background jobs and file names have no reader's device to ask, so they use WIB.
export const formatWib = (value: DateInput, format: DateFormatName): string =>
  formatDateIn(value, format, WIB_TIME_ZONE);

export const formatWibDateStamp = (value: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: WIB_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
