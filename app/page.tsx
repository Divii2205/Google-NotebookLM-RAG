"use client";

import { FormEvent, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { UploadDropzone } from "@/components/upload-dropzone";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type Grade = "correct" | "ambiguous" | "incorrect";

type SourceItem = {
  rank: number;
  score: number;
  snippet: string;
  metadata: Record<string, unknown>;
  grade?: Grade;
};

type RetrievalTrace = {
  status: "grounded" | "corrected" | "not_found";
  rewrites: number;
  rewrittenQueries: string[];
  verdicts: { rank: number; score: number; grade: Grade }[];
};

function shortSnippet(text: string) {
  return text.length > 220 ? `${text.slice(0, 220).trim()}...` : text;
}

function describeLocation(metadata: Record<string, unknown>): string | null {
  const loc = metadata.loc as { pageNumber?: number; lines?: { from?: number; to?: number } } | undefined;
  if (loc?.pageNumber) {
    if (loc.lines?.from && loc.lines?.to) {
      return `Page ${loc.pageNumber} · lines ${loc.lines.from}-${loc.lines.to}`;
    }
    return `Page ${loc.pageNumber}`;
  }
  if (typeof metadata.row === "number") {
    return `CSV row ${metadata.row + 1}`;
  }
  return null;
}

const STATUS_BADGE: Record<RetrievalTrace["status"], { label: string; className: string }> = {
  grounded: { label: "Grounded ✓", className: "border-turquoise bg-turquoise/10 text-turquoise-deep" },
  corrected: { label: "Corrected ↻", className: "border-amber-400 bg-amber-50 text-amber-700" },
  not_found: { label: "Not found in document", className: "border-slate-300 bg-slate-100 text-slate-500" }
};

const GRADE_BADGE: Record<Grade, { label: string; className: string }> = {
  correct: { label: "relevant", className: "bg-turquoise/15 text-turquoise-deep" },
  ambiguous: { label: "partial", className: "bg-amber-100 text-amber-700" },
  incorrect: { label: "weak", className: "bg-slate-100 text-slate-500" }
};

export default function HomePage() {
  const [collectionName, setCollectionName] = useState<string | null>(null);
  const [documentName, setDocumentName] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [retrieval, setRetrieval] = useState<RetrievalTrace | null>(null);
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<string>("Upload a file to begin.");
  const [isUploading, setIsUploading] = useState(false);
  const [isChatting, setIsChatting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileSelected(file: File) {
    setIsUploading(true);
    setError(null);
    setStatus(`Indexing ${file.name}...`);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/ingest", {
        method: "POST",
        body: formData
      });

      const payload = (await response.json()) as
        | { collectionName: string; fileName: string; chunkCount: number }
        | { error: string };

      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "Failed to ingest file.");
      }

      setCollectionName(payload.collectionName);
      setDocumentName(payload.fileName);
      setChunkCount(payload.chunkCount);
      setMessages([
        {
          role: "assistant",
          content: `Indexed ${payload.fileName} into ${payload.chunkCount} chunks. Ask a question to start.`
        }
      ]);
      setSources([]);
      setRetrieval(null);
      setStatus("Document ready. Ask a question grounded in the uploaded file.");
    } catch (ingestError) {
      const message = ingestError instanceof Error ? ingestError.message : "Unable to index the document.";
      setError(message);
      setStatus("Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!collectionName) {
      setError("Upload a document first.");
      return;
    }

    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isChatting) {
      return;
    }

    setIsChatting(true);
    setError(null);
    setQuestion("");
    setMessages((current) => [...current, { role: "user", content: trimmedQuestion }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ collectionName, question: trimmedQuestion })
      });

      const payload = (await response.json()) as
        | { answer: string; sources: SourceItem[]; retrieval?: RetrievalTrace }
        | { error: string };

      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "Failed to generate an answer.");
      }

      setMessages((current) => [...current, { role: "assistant", content: payload.answer }]);
      setSources(payload.sources);
      setRetrieval(payload.retrieval ?? null);

      if (payload.retrieval?.status === "corrected") {
        setStatus("Retrieval was corrected — rewrote the query to find relevant context.");
      } else if (payload.retrieval?.status === "not_found") {
        setStatus("No relevant context found in the uploaded document.");
      } else {
        setStatus("Answer grounded in the uploaded document.");
      }
    } catch (chatError) {
      const message = chatError instanceof Error ? chatError.message : "Unable to answer the question.";
      setError(message);
      setStatus("Question failed.");
    } finally {
      setIsChatting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-6 lg:px-8">
      <section className="rounded-[2rem] border border-slate-200 bg-white/85 p-5 shadow-sm backdrop-blur md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-3">
            <p className="inline-flex rounded-full border border-turquoise bg-turquoise/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-turquoise-deep">
              Mini-NotebookLM
            </p>
            <h1 className="font-[family-name:var(--font-space-grotesk)] text-3xl font-semibold tracking-tight text-slate-950 md:text-5xl">
              Ask questions over your own files with grounded answers.
            </h1>
            <p className="text-sm leading-6 text-slate-600 md:text-base">
              Upload a PDF, TXT, or CSV file, index it into Qdrant, and use Gemini-backed retrieval to chat only with the document.
            </p>
          </div>

          <div className="grid gap-3 text-sm text-slate-600 sm:grid-cols-3 lg:min-w-[420px]">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Status</p>
              <p className="mt-1 font-medium text-slate-900">{status}</p>
            </div>
            <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Document</p>
              <p className="mt-1 truncate font-medium text-slate-900" title={documentName ?? "None yet"}>{documentName ?? "None yet"}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Chunks</p>
              <p className="mt-1 font-medium text-slate-900">{chunkCount ?? 0}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
        <aside className="flex h-[800px] flex-col gap-4 rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-turquoise-deep">Source panel</p>
            <h2 className="mt-2 text-lg font-semibold text-slate-950">Upload a source</h2>
            <p className="mt-1 text-sm text-slate-500">One active collection is kept at a time for a clean NotebookLM-style workflow.</p>
          </div>

          <UploadDropzone
            onFileSelected={handleFileSelected}
            busy={isUploading || isChatting}
            isUploading={isUploading}
          />

          <div className="min-w-0 rounded-3xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Active source</p>
            <div className="mt-3 space-y-1 text-sm">
              <p className="truncate font-medium text-slate-900" title={documentName ?? "No file uploaded"}>{documentName ?? "No file uploaded"}</p>
              <p className="truncate text-slate-500" title={collectionName ?? "n/a"}>Collection: {collectionName ?? "n/a"}</p>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Sources</p>
              <span className="rounded-full border border-turquoise px-2 py-1 text-xs font-semibold text-turquoise-deep">
                {sources.length}
              </span>
            </div>

            {retrieval ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Corrective RAG
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[retrieval.status].className}`}
                  >
                    {STATUS_BADGE[retrieval.status].label}
                  </span>
                </div>
                {retrieval.rewrittenQueries.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-[0.65rem] uppercase tracking-[0.18em] text-slate-400">
                      Retried with {retrieval.rewrites} rewrite{retrieval.rewrites === 1 ? "" : "s"}
                    </p>
                    <ul className="space-y-1">
                      {retrieval.rewrittenQueries.map((q, i) => (
                        <li key={`${i}-${q}`} className="truncate text-xs text-slate-600" title={q}>
                          ↳ {q}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            {sources.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                Retrieved chunks will appear here after you ask a question.
              </div>
            ) : (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 scrollbar-hidden">
                {sources.map((source) => {
                  const location = describeLocation(source.metadata);
                  return (
                    <article key={`${source.rank}-${source.score}`} className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span className="flex items-center gap-2">
                          <span>Chunk {source.rank}{location ? ` · ${location}` : ""}</span>
                          {source.grade ? (
                            <span className={`rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ${GRADE_BADGE[source.grade].className}`}>
                              {GRADE_BADGE[source.grade].label}
                            </span>
                          ) : null}
                        </span>
                        <span>Score {source.score.toFixed(3)}</span>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-slate-700">{shortSnippet(source.snippet)}</p>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <section className="flex h-[800px] flex-col rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-turquoise-deep">Chat</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">Conversation grounded in the document</h2>
            </div>
            <div className="rounded-full border border-turquoise bg-turquoise/10 px-3 py-1 text-xs font-semibold text-turquoise-deep">
              Gemini + Qdrant + LangChain
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-5 scrollbar-hidden">
            {messages.length === 0 ? (
              <div className="flex h-full min-h-[420px] items-center justify-center rounded-[1.75rem] border border-dashed border-slate-200 bg-slate-50 px-6 text-center text-slate-500">
                Upload a document, then ask a question about its content.
              </div>
            ) : (
              messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-3xl rounded-[1.5rem] px-4 py-3 text-sm leading-7 shadow-sm ${
                      message.role === "user"
                        ? "border border-turquoise bg-turquoise/15"
                        : "border border-slate-200 bg-slate-50 text-slate-800"
                    }`}
                  >
                    {message.role === "assistant" ? (
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <span className="whitespace-pre-wrap">{message.content}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <form onSubmit={handleAsk} className="border-t border-slate-200 pt-4">
            <label className="mb-3 block text-sm font-medium text-slate-700" htmlFor="question">
              Ask something specific about the uploaded document
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                id="question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="e.g. Summarize the main points in three bullets"
                className="min-h-12 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none transition focus:border-turquoise focus:bg-white focus:ring-4 focus:ring-turquoise/15"
              />
              <button
                type="submit"
                disabled={!collectionName || isChatting}
                className="inline-flex min-h-12 items-center justify-center rounded-2xl border border-turquoise bg-turquoise px-5 text-sm font-semibold text-slate-950 transition hover:bg-turquoise-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isChatting ? "Searching..." : "Ask"}
              </button>
            </div>

            {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
          </form>
        </section>
      </section>
    </main>
  );
}