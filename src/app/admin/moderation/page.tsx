import { ModerationConsole } from "./moderation-console";

// Protected by /admin/layout.tsx — platform_ops only. Minimal proof moderation console.
export default function AdminModerationPage() {
  return (
    <div
      style={{
        fontFamily: "Arial, sans-serif",
        maxWidth: 820,
        margin: "32px auto",
        padding: "0 16px",
        color: "#0f1012",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Moderasi & Dukungan</h1>
      <p style={{ color: "#555", marginBottom: 20, fontSize: 14 }}>
        Platform Ops — cari pengguna atau institusi untuk menangguhkan, memulihkan, dan menambah
        catatan internal.
      </p>
      <ModerationConsole />
    </div>
  );
}
