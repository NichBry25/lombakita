const read = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const publicEnv = {
  appName: read(process.env.NEXT_PUBLIC_APP_NAME) ?? "Lombakita",
  appEnv: read(process.env.NEXT_PUBLIC_APP_ENV) ?? "development",
  appUrl: read(process.env.NEXT_PUBLIC_APP_URL) ?? "http://localhost:3000",
} as const;

export type PublicEnv = typeof publicEnv;
