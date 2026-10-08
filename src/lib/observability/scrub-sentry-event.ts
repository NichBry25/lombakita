import type { Breadcrumb, Event } from "@sentry/nextjs";

const ALLOWED_REQUEST_HEADERS = new Set([
  "user-agent",
  "accept-language",
  "content-type",
  "host",
  "x-vercel-id",
]);

function stripUrlSuffix(url: string): string {
  const suffixStart = url.search(/[?#]/);
  return suffixStart === -1 ? url : url.slice(0, suffixStart);
}

function scrubSentryRequest(request: NonNullable<Event["request"]>): NonNullable<Event["request"]> {
  const scrubbedRequest = { ...request };
  delete scrubbedRequest.cookies;
  delete scrubbedRequest.data;
  delete scrubbedRequest.query_string;
  delete scrubbedRequest.env;

  if (request.headers) {
    const allowedHeaders = Object.entries(request.headers).filter(([name]) =>
      ALLOWED_REQUEST_HEADERS.has(name.toLowerCase()),
    );
    scrubbedRequest.headers = Object.fromEntries(allowedHeaders);
  }

  if (typeof request.url === "string") {
    scrubbedRequest.url = stripUrlSuffix(request.url);
  }

  return scrubbedRequest;
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  const scrubbedEvent = { ...event };
  delete scrubbedEvent.user;

  if (event.request) {
    scrubbedEvent.request = scrubSentryRequest(event.request);
  }

  const nextjs = event.contexts?.nextjs;
  if (typeof nextjs?.request_path === "string") {
    scrubbedEvent.contexts = {
      ...event.contexts,
      nextjs: { ...nextjs, request_path: stripUrlSuffix(nextjs.request_path) },
    };
  }

  const chainHasDrizzle =
    event.exception?.values?.some(({ value }) => value?.includes("Failed query:")) ?? false;
  if (chainHasDrizzle && event.exception?.values) {
    scrubbedEvent.exception = {
      ...event.exception,
      values: event.exception.values.map((exception) => {
        const value = exception.value;
        const queryStart = value?.indexOf("Failed query:") ?? -1;
        if (!value || queryStart === -1) {
          return { ...exception, value: "[redacted: database error]" };
        }
        const paramsStart = value.indexOf("\nparams:", queryStart);
        if (paramsStart === -1) {
          return exception;
        }
        return { ...exception, value: `${value.slice(0, paramsStart)}\nparams: [redacted]` };
      }),
    };
  }

  if (event.breadcrumbs) {
    scrubbedEvent.breadcrumbs = event.breadcrumbs
      .map(scrubSentryBreadcrumb)
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);
  }

  return scrubbedEvent;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") {
    return null;
  }

  if (!breadcrumb.data) {
    return { ...breadcrumb };
  }

  const data = { ...breadcrumb.data };
  delete data["http.query"];
  delete data["http.fragment"];
  for (const key of ["url", "from", "to"]) {
    if (typeof data[key] === "string") {
      data[key] = stripUrlSuffix(data[key]);
    }
  }

  return { ...breadcrumb, data };
}
