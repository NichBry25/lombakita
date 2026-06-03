import { notFound } from "next/navigation";
import { DevPrimitivesClient } from "./dev-primitives-client";

export default function DevPrimitivesPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>UI Primitives — Dev Verification</h1>
      <p style={{ color: "#666", marginBottom: "1.5rem" }}>
        Accessible in development only (NODE_ENV !== &apos;production&apos;).
      </p>
      <DevPrimitivesClient />
    </main>
  );
}
