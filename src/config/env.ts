const read = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const ENV_NAMES = ["local", "preview", "staging", "production", "test"] as const;

export type AppEnvironment = (typeof ENV_NAMES)[number];

const isAppEnvironment = (value: string): value is AppEnvironment => {
  return (ENV_NAMES as readonly string[]).includes(value);
};

export const resolveAppEnvironment = (input?: string): AppEnvironment => {
  const explicit = read(input);

  if (explicit === "prod") {
    return "production";
  }

  if (explicit === "dev") {
    return "local";
  }

  if (explicit && isAppEnvironment(explicit)) {
    return explicit;
  }

  const nodeEnv = read(process.env.NODE_ENV);
  if (nodeEnv === "test") {
    return "test";
  }

  const vercelEnv = read(process.env.VERCEL_ENV);
  if (vercelEnv === "preview") {
    return "preview";
  }

  if (nodeEnv === "production") {
    return "production";
  }

  return "local";
};

const toHttpsUrl = (value: string): string => {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  return `https://${value}`;
};

export const resolvePublicAppUrl = (options?: {
  appEnv?: AppEnvironment;
  explicitUrl?: string;
  vercelUrl?: string;
}): string | undefined => {
  const appEnv = options?.appEnv ?? resolveAppEnvironment(process.env.NEXT_PUBLIC_APP_ENV);
  const explicitUrl = read(options?.explicitUrl ?? process.env.NEXT_PUBLIC_APP_URL);

  if (explicitUrl) {
    return explicitUrl;
  }

  const vercelUrl = read(options?.vercelUrl ?? process.env.VERCEL_URL);
  if (vercelUrl) {
    return toHttpsUrl(vercelUrl);
  }

  if (appEnv === "local" || appEnv === "test") {
    return "http://localhost:3000";
  }

  return undefined;
};

export const publicEnv = {
  appName: read(process.env.NEXT_PUBLIC_APP_NAME) ?? "Lombakita",
  appEnv: resolveAppEnvironment(process.env.NEXT_PUBLIC_APP_ENV),
  appUrl: resolvePublicAppUrl(),
} as const;
