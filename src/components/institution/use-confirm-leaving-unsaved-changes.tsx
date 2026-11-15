"use client";

import { useModal } from "@/components/ui/primitives";

// Opens the pop-up that asks whether to drop what was typed. `leave` runs only if the user chooses
// to drop it.
export function useConfirmLeavingUnsavedChanges() {
  const { openModal } = useModal();

  return (leave: () => void) => {
    openModal({
      title: "Keluar tanpa menyimpan?",
      body: "Perubahan di halaman ini belum tersimpan dan akan hilang jika Anda keluar.",
      alert: true,
      actions: [
        { label: "Tetap di sini" },
        { label: "Buang perubahan", variant: "primary", onClick: leave },
      ],
    });
  };
}
