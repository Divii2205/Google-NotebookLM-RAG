"use client";

import { useRef, useState } from "react";

type UploadDropzoneProps = {
  onFileSelected: (file: File) => Promise<void>;
  busy: boolean;
  isUploading: boolean;
};

export function UploadDropzone({ onFileSelected, busy, isUploading }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  async function handleFile(file: File | null) {
    if (!file || busy) {
      return;
    }

    await onFileSelected(file);
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!busy) {
          setIsDragging(true);
        }
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={async (event) => {
        event.preventDefault();
        setIsDragging(false);
        await handleFile(event.dataTransfer.files[0] ?? null);
      }}
      className={`rounded-3xl border border-dashed px-5 py-6 transition-all ${
        isDragging ? "border-turquoise bg-turquoise/10 shadow-halo" : "border-slate-200 bg-white"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.txt,.csv,application/pdf,text/plain,text/csv"
        className="hidden"
        onChange={async (event) => {
          await handleFile(event.target.files?.[0] ?? null);
          event.target.value = "";
        }}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="flex w-full flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-6 py-8 text-center transition hover:border-turquoise hover:bg-turquoise/5 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isUploading ? (
          <>
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-turquoise/40 border-t-turquoise" />
            <div>
              <p className="text-base font-semibold text-slate-900">Uploading and indexing...</p>
              <p className="mt-1 text-sm text-slate-500">Chunking, embedding, and storing in Qdrant.</p>
            </div>
          </>
        ) : (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-turquoise bg-white text-lg font-semibold text-turquoise-deep">
              +
            </div>
            <div>
              <p className="text-base font-semibold text-slate-900">Drop a PDF, TXT, or CSV file here</p>
            </div>
          </>
        )}
      </button>
    </div>
  );
}