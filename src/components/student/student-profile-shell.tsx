"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";

type ThemeMode = "light" | "dark";

type StudentProfileResponse = {
  profile: {
    userId: string;
    email: string;
    displayName: string | null;
    phoneNumber: string | null;
    headline: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
};

type StudentProfileFormState = {
  email: string;
  displayName: string;
  phoneNumber: string;
  headline: string;
};

type FeedbackState =
  | {
      type: "success";
      message: string;
    }
  | {
      type: "error";
      message: string;
    }
  | null;

const studentSidebarSections = [
  {
    title: "Akun Mahasiswa",
    items: [
      { label: "Profil Saya", hint: "Aktif", active: true, icon: "profile" as const },
      { label: "Preferensi Notifikasi", hint: "Segera", active: false, icon: "bell" as const },
    ],
  },
  {
    title: "Perjalanan Kompetisi",
    items: [
      { label: "Jelajah Kompetisi", hint: "Segera", active: false, icon: "search" as const },
      { label: "Registrasi Saya", hint: "Segera", active: false, icon: "list" as const },
      { label: "Tim Saya", hint: "Segera", active: false, icon: "team" as const },
    ],
  },
] as const;

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as {
      error?: {
        message?: string;
      };
    };

    return payload.error?.message ?? "Permintaan profil gagal diproses.";
  } catch {
    return "Permintaan profil gagal diproses.";
  }
};

const SidebarIcon = ({ icon }: { icon: "profile" | "bell" | "search" | "list" | "team" }) => {
  const commonProps = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": true,
    className: "shrink-0",
  } as const;

  if (icon === "profile") {
    return (
      <svg {...commonProps}>
        <path
          d="M12 12.5C14.4853 12.5 16.5 10.4853 16.5 8C16.5 5.51472 14.4853 3.5 12 3.5C9.51472 3.5 7.5 5.51472 7.5 8C7.5 10.4853 9.51472 12.5 12 12.5Z"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M5 19.5C5.89455 16.8755 8.79695 15 12 15C15.2031 15 18.1055 16.8755 19 19.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (icon === "bell") {
    return (
      <svg {...commonProps}>
        <path
          d="M6.5 10.5C6.5 7.46243 8.96243 5 12 5C15.0376 5 17.5 7.46243 17.5 10.5V13.2C17.5 14.0941 17.8552 14.9518 18.4874 15.584L19 16.0966V17H5V16.0966L5.51256 15.584C6.14482 14.9518 6.5 14.0941 6.5 13.2V10.5Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10 19C10.3854 19.6215 11.1223 20 12 20C12.8777 20 13.6146 19.6215 14 19"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (icon === "search") {
    return (
      <svg {...commonProps}>
        <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M16 16L19.5 19.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (icon === "list") {
    return (
      <svg {...commonProps}>
        <path d="M8 7H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M8 12H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M8 17H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="4.5" cy="7" r="1" fill="currentColor" />
        <circle cx="4.5" cy="12" r="1" fill="currentColor" />
        <circle cx="4.5" cy="17" r="1" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <circle cx="8.5" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="15.5" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3.5 19C4.11174 16.9538 6.00657 15.5 8.25 15.5C10.4934 15.5 12.3883 16.9538 13 19"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M11 19C11.6117 16.9538 13.5066 15.5 15.75 15.5C17.9934 15.5 19.8883 16.9538 20.5 19"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
};

const ProfileSkeleton = () => {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-5 w-52 rounded-xl bg-[var(--skeleton)]" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <div className="h-4 w-24 rounded-lg bg-[var(--skeleton)]" />
          <div className="h-12 w-full rounded-2xl bg-[var(--skeleton)]" />
        </div>
        <div className="space-y-2">
          <div className="h-4 w-24 rounded-lg bg-[var(--skeleton)]" />
          <div className="h-12 w-full rounded-2xl bg-[var(--skeleton)]" />
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-4 w-44 rounded-lg bg-[var(--skeleton)]" />
        <div className="h-20 w-full rounded-2xl bg-[var(--skeleton)]" />
      </div>
      <div className="h-11 w-40 rounded-2xl bg-[var(--skeleton)]" />
    </div>
  );
};

export const StudentProfileShell = () => {
  const [theme, setTheme] = useState<ThemeMode>("light");
  const hasAppliedInitialTheme = useRef(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [formState, setFormState] = useState<StudentProfileFormState>({
    email: "",
    displayName: "",
    phoneNumber: "",
    headline: "",
  });

  const loadProfile = useCallback(async () => {
    setIsLoading(true);
    setFeedback(null);

    const response = await fetch("/api/v1/students/me/profile", {
      cache: "no-store",
      credentials: "include",
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);

      setFeedback({
        type: "error",
        message,
      });
      setIsLoading(false);
      return;
    }

    const data = (await response.json()) as StudentProfileResponse;

    setFormState({
      email: data.profile.email,
      displayName: data.profile.displayName ?? "",
      phoneNumber: data.profile.phoneNumber ?? "",
      headline: data.profile.headline ?? "",
    });
    setIsLoading(false);
  }, []);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("lombakita-theme");
    const resolvedTheme =
      storedTheme === "light" || storedTheme === "dark" ? storedTheme : "light";

    if (resolvedTheme !== "light") {
      const frameId = window.requestAnimationFrame(() => {
        setTheme(resolvedTheme);
        document.documentElement.setAttribute("data-theme", resolvedTheme);
        window.localStorage.setItem("lombakita-theme", resolvedTheme);
        hasAppliedInitialTheme.current = true;
      });

      return () => {
        window.cancelAnimationFrame(frameId);
      };
    }

    hasAppliedInitialTheme.current = true;
    document.documentElement.setAttribute("data-theme", "light");
    window.localStorage.setItem("lombakita-theme", "light");
  }, []);

  useEffect(() => {
    if (!hasAppliedInitialTheme.current) {
      return;
    }

    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("lombakita-theme", theme);
  }, [theme]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadProfile();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadProfile]);

  const canSubmit = useMemo(() => {
    return formState.displayName.trim().length >= 2;
  }, [formState.displayName]);

  const updateField = <K extends keyof StudentProfileFormState>(
    key: K,
    value: StudentProfileFormState[K],
  ) => {
    setFormState((previous) => ({
      ...previous,
      [key]: value,
    }));
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!canSubmit) {
      setFeedback({
        type: "error",
        message: "Nama lengkap minimal terdiri dari 2 karakter.",
      });
      return;
    }

    setIsSaving(true);
    setFeedback(null);

    const response = await fetch("/api/v1/students/me/profile", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        displayName: formState.displayName,
        phoneNumber: formState.phoneNumber,
        headline: formState.headline,
      }),
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);

      setFeedback({
        type: "error",
        message,
      });
      setIsSaving(false);
      return;
    }

    const data = (await response.json()) as StudentProfileResponse;

    setFormState({
      email: data.profile.email,
      displayName: data.profile.displayName ?? "",
      phoneNumber: data.profile.phoneNumber ?? "",
      headline: data.profile.headline ?? "",
    });
    setFeedback({
      type: "success",
      message: "Profil berhasil diperbarui.",
    });
    setIsSaving(false);
  };

  return (
    <main className="min-h-screen px-4 py-5 md:px-8 md:py-7">
      <div className="mx-auto grid w-full max-w-7xl gap-5 lg:grid-cols-[270px_minmax(0,1fr)]">
        <aside className="glass-card p-4 lg:sticky lg:top-5 lg:h-[calc(100vh-2.5rem)] lg:overflow-y-auto">
          <div className="mb-5 flex items-center gap-3 rounded-2xl bg-[var(--surface-muted)] p-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-strong)] text-[var(--text-contrast)]">
              <svg
                aria-hidden
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M7 10.5L12 5.5L17 10.5M7 13.5L12 18.5L17 13.5"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <p className="text-gleam text-sm font-semibold text-[var(--text-primary)]">
                Lombakita Student
              </p>
              <p className="text-xs text-[var(--text-muted)]">Area akun mahasiswa</p>
            </div>
          </div>

          <nav className="space-y-4">
            {studentSidebarSections.map((section) => (
              <div key={section.title}>
                <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  {section.title}
                </p>
                <ul className="space-y-2">
                  {section.items.map((item) => (
                    <li key={item.label}>
                      <div
                        className={`sidebar-item ${item.active ? "sidebar-item-active" : "sidebar-item-inactive"}`}
                      >
                        <span className="text-[var(--text-muted)]">
                          <SidebarIcon icon={item.icon} />
                        </span>
                        <span className="grow truncate text-sm font-medium">{item.label}</span>
                        <span className="rounded-full bg-[var(--badge-bg)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--badge-text)]">
                          {item.hint}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <section className="space-y-5">
          <header className="glass-card sticky top-5 z-20 p-4 md:p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <h1 className="text-gleam text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
                  Profil Mahasiswa
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="action-chip"
                  onClick={() => {
                    setTheme((prev) => (prev === "light" ? "dark" : "light"));
                  }}
                >
                  {theme === "light" ? "Dark mode" : "Light mode"}
                </button>
                <SignOutButton />
              </div>
            </div>
          </header>

          <section className="glass-card p-4 md:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-gleam text-lg font-semibold text-[var(--text-primary)]">
                Data Profil
              </h2>
            </div>

            {feedback ? (
              <div
                className={`mb-4 rounded-xl px-4 py-2.5 text-sm ${
                  feedback.type === "success"
                    ? "border border-emerald-300/70 bg-emerald-100/70 text-emerald-900"
                    : "border border-rose-300/70 bg-rose-100/70 text-rose-900"
                }`}
                role="status"
              >
                {feedback.message}
              </div>
            ) : null}

            {isLoading ? (
              <ProfileSkeleton />
            ) : (
              <form className="space-y-4" onSubmit={onSubmit}>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="form-field">
                    <span className="form-label">Nama lengkap</span>
                    <input
                      className="form-input"
                      value={formState.displayName}
                      onChange={(event) => {
                        updateField("displayName", event.currentTarget.value);
                      }}
                      placeholder="Contoh: Aulia Rahman Putri"
                      minLength={2}
                      maxLength={120}
                      required
                    />
                  </label>

                  <label className="form-field">
                    <span className="form-label">Nomor telepon</span>
                    <input
                      className="form-input"
                      value={formState.phoneNumber}
                      onChange={(event) => {
                        updateField("phoneNumber", event.currentTarget.value);
                      }}
                      placeholder="+6281234567890"
                      maxLength={20}
                      inputMode="tel"
                    />
                  </label>
                </div>

                <label className="form-field">
                  <span className="form-label">Email</span>
                  <input
                    className="form-input form-input-readonly"
                    value={formState.email}
                    disabled
                    readOnly
                  />
                </label>

                <label className="form-field">
                  <span className="form-label">Headline singkat</span>
                  <textarea
                    className="form-input min-h-28 resize-y py-3"
                    value={formState.headline}
                    onChange={(event) => {
                      updateField("headline", event.currentTarget.value);
                    }}
                    maxLength={160}
                    placeholder="Mahasiswa Teknik Informatika yang aktif di kompetisi produk digital."
                  />
                </label>

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={isSaving || !canSubmit}
                  >
                    {isSaving ? "Menyimpan..." : "Simpan perubahan"}
                  </button>
                  <button
                    type="button"
                    className="action-chip"
                    disabled={isSaving}
                    onClick={() => {
                      void loadProfile();
                    }}
                  >
                    Muat ulang
                  </button>
                </div>
              </form>
            )}
          </section>
        </section>
      </div>
    </main>
  );
};
