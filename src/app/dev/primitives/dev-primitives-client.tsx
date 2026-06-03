"use client";

import { useModal, useToast } from "@/components/ui/primitives";

export function DevPrimitivesClient() {
  const { openModal } = useModal();
  const { addToast } = useToast();

  function openTwoActionModal() {
    openModal({
      title: "Konfirmasi Tindakan",
      body: "Apakah Anda yakin ingin melanjutkan? Tindakan ini tidak dapat dibatalkan.",
      onClose: () => console.log("[dev] modal onClose fired"),
      actions: [
        {
          label: "Konfirmasi",
          variant: "primary",
          autoClose: true,
          onClick: () => console.log("[dev] Confirm clicked"),
        },
        {
          label: "Batal",
          variant: "secondary",
          autoClose: true,
          onClick: () => console.log("[dev] Cancel clicked"),
        },
      ],
    });
  }

  function openNoCloseModal() {
    openModal({
      title: "Modal Tanpa Tombol Tutup",
      body: "Modal ini tidak memiliki tombol ×. Gunakan salah satu tombol aksi di bawah.",
      closeable: false,
      onClose: () => console.log("[dev] no-close modal onClose fired"),
      actions: [
        {
          label: "Mengerti",
          variant: "primary",
          autoClose: true,
          onClick: () => console.log("[dev] Understood clicked"),
        },
      ],
    });
  }

  const BTN_STYLE = {
    padding: "0.5rem 1rem",
    borderRadius: 4,
    border: "1px solid #ccc",
    cursor: "pointer",
    background: "#f5f5f5",
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: "0.75rem" }}>
      <button style={BTN_STYLE} onClick={openTwoActionModal}>
        Open modal (2 actions)
      </button>
      <button style={BTN_STYLE} onClick={openNoCloseModal}>
        Open modal (no close button)
      </button>
      <button style={{ ...BTN_STYLE, borderColor: "#c0392b" }} onClick={() => addToast({ message: "Terjadi kesalahan. Coba lagi.", type: "error" })}>
        Toast: error
      </button>
      <button style={{ ...BTN_STYLE, borderColor: "#27ae60" }} onClick={() => addToast({ message: "Operasi berhasil.", type: "success" })}>
        Toast: success
      </button>
      <button style={{ ...BTN_STYLE, borderColor: "#2980b9" }} onClick={() => addToast({ message: "Informasi tambahan tersedia.", type: "info" })}>
        Toast: info
      </button>
      <button style={{ ...BTN_STYLE, borderColor: "#d68910" }} onClick={() => addToast({ message: "Perhatikan langkah berikutnya.", type: "warning" })}>
        Toast: warning
      </button>
    </div>
  );
}
