import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Document } from "@langchain/core/documents";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { parse as csvParse } from "csv-parse/sync";
import { join, extname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getGeminiApiKey, getQdrantApiKey, getQdrantUrl } from "@/lib/env";

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 180
});

// --- Corrective RAG (CRAG) tuning ---
// How many chunks to pull from Qdrant per query.
const RETRIEVAL_K = 6;
// How many times we may rewrite the query + re-retrieve before abstaining.
const MAX_REWRITES = 2;
// Snippet length (chars) sent to the grader — keeps the grading call cheap.
const GRADE_SNIPPET_CHARS = 600;

function normalizeCollectionName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildCollectionName(fileName: string) {
  const stem = normalizeCollectionName(basename(fileName, extname(fileName)) || "document");
  return `mnlm-${stem}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function locationLabel(meta: Record<string, unknown>): string | null {
  const loc = meta.loc as { pageNumber?: number; lines?: { from?: number; to?: number } } | undefined;
  if (loc?.pageNumber) {
    if (loc.lines?.from && loc.lines?.to) {
      return `page ${loc.pageNumber}, lines ${loc.lines.from}-${loc.lines.to}`;
    }
    return `page ${loc.pageNumber}`;
  }
  if (typeof meta.row === "number") {
    return `CSV row ${(meta.row as number) + 1}`;
  }
  return null;
}

function contentToString(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("\n");
  }

  return String(content);
}

async function loadFileDocuments(filePath: string, originalName: string, mimeType: string) {
  const lowerName = originalName.toLowerCase();

  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    const pdfDocs = await new PDFLoader(filePath).load();
    return pdfDocs.map(
      (doc) =>
        new Document({
          pageContent: doc.pageContent,
          metadata: { ...doc.metadata, sourceName: originalName, mimeType }
        })
    );
  }

  if (mimeType === "text/csv" || mimeType === "application/vnd.ms-excel" || lowerName.endsWith(".csv")) {
    const text = await readFile(filePath, "utf-8");
    const records = csvParse(text, { columns: true, skip_empty_lines: true });

    return (records as Array<Record<string, unknown>>).map(
      (row, idx) =>
        new Document({
          pageContent: Object.entries(row)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n"),
          metadata: { sourceName: originalName, row: idx, mimeType }
        })
    );
  }

  const text = await readFile(filePath, "utf-8");
  return [
    new Document({
      pageContent: text,
      metadata: { source: filePath, sourceName: originalName, mimeType }
    })
  ];
}

async function storeTemporaryUpload(file: File) {
  const workspaceDir = join(tmpdir(), "mini-notebooklm");
  await mkdir(workspaceDir, { recursive: true });

  const safeName = `${Date.now()}-${randomUUID()}-${file.name}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  const tempPath = join(workspaceDir, safeName);
  const bytes = await file.arrayBuffer();

  await writeFile(tempPath, Buffer.from(bytes));

  return tempPath;
}

async function getEmbeddings() {
  return new GoogleGenerativeAIEmbeddings({
    apiKey: getGeminiApiKey(),
    model: "gemini-embedding-001"
  });
}

function getVectorStoreOptions(collectionName: string) {
  return {
    url: getQdrantUrl(),
    apiKey: getQdrantApiKey(),
    collectionName
  };
}

export async function ingestDocument(file: File) {
  const lowerName = file.name.toLowerCase();
  const allowedMimeTypes = new Set(["application/pdf", "text/plain", "text/csv", "application/vnd.ms-excel"]);
  const allowedExtensions = [".pdf", ".txt", ".csv"];
  const isAllowed =
    allowedMimeTypes.has(file.type) || allowedExtensions.some((ext) => lowerName.endsWith(ext));

  if (!isAllowed) {
    throw new Error("Only PDF, TXT, and CSV files are supported.");
  }

  const tempPath = await storeTemporaryUpload(file);
  const collectionName = buildCollectionName(file.name);

  try {
    const sourceDocuments = await loadFileDocuments(tempPath, file.name, file.type);
    const rawChunks = await splitter.splitDocuments(sourceDocuments);
    const chunks = rawChunks.filter((chunk) => chunk.pageContent.trim().length > 0);

    if (chunks.length === 0) {
      throw new Error("No readable text was found in the uploaded file.");
    }

    const embeddings = await getEmbeddings();
    const validDocs: Document[] = [];
    const validVectors: number[][] = [];
    const batchSize = 20;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      let vectors: number[][] = [];
      try {
        vectors = await embeddings.embedDocuments(batch.map((c) => c.pageContent));
      } catch {
        for (const chunk of batch) {
          try {
            const [vec] = await embeddings.embedDocuments([chunk.pageContent]);
            if (Array.isArray(vec) && vec.length > 0) {
              validDocs.push(chunk);
              validVectors.push(vec);
            }
          } catch {
            // skip individual failures (e.g. safety-filtered content)
          }
        }
        continue;
      }

      vectors.forEach((vec, idx) => {
        if (Array.isArray(vec) && vec.length > 0) {
          validDocs.push(batch[idx]);
          validVectors.push(vec);
        }
      });
    }

    if (validVectors.length === 0) {
      throw new Error("No chunks could be embedded — the content may have been blocked by safety filters.");
    }

    const store = new QdrantVectorStore(embeddings, getVectorStoreOptions(collectionName));
    await store.addVectors(validVectors, validDocs);

    return {
      collectionName,
      fileName: file.name,
      chunkCount: validVectors.length
    };
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

type Grade = "correct" | "ambiguous" | "incorrect";

type GradedSource = {
  rank: number;
  score: number;
  snippet: string;
  metadata: Record<string, unknown>;
  grade: Grade;
};

function getChatModel(temperature: number) {
  return new ChatGoogleGenerativeAI({
    apiKey: getGeminiApiKey(),
    model: "gemini-flash-latest",
    temperature
  });
}

// Retrieve for one or more queries, merge results, and keep the best score per
// unique chunk so that a rewrite that overlaps the original query does not
// produce duplicate sources.
async function retrieveForQueries(
  store: QdrantVectorStore,
  queries: string[],
  k: number
): Promise<Array<{ snippet: string; score: number; metadata: Record<string, unknown> }>> {
  const byContent = new Map<string, { snippet: string; score: number; metadata: Record<string, unknown> }>();

  for (const query of queries) {
    const matches = await store.similaritySearchWithScore(query, k);
    for (const [doc, score] of matches) {
      const existing = byContent.get(doc.pageContent);
      if (!existing || score > existing.score) {
        byContent.set(doc.pageContent, {
          snippet: doc.pageContent,
          score,
          metadata: doc.metadata as Record<string, unknown>
        });
      }
    }
  }

  return Array.from(byContent.values()).sort((a, b) => b.score - a.score);
}

// Retrieval evaluator: ask Gemini to grade each retrieved chunk against the
// question in a single structured call (one LLM call per round, not per chunk).
async function gradeChunks(
  question: string,
  chunks: Array<{ snippet: string }>
): Promise<Grade[]> {
  if (chunks.length === 0) {
    return [];
  }

  const schema = z.object({
    verdicts: z.array(
      z.object({
        rank: z.number().describe("1-based index of the source being graded"),
        grade: z
          .enum(["correct", "ambiguous", "incorrect"])
          .describe(
            "correct = directly answers/strongly supports the question; ambiguous = related but partial/uncertain; incorrect = unrelated"
          )
      })
    )
  });

  const numbered = chunks
    .map((chunk, index) => `Source ${index + 1}:\n${chunk.snippet.slice(0, GRADE_SNIPPET_CHARS)}`)
    .join("\n\n");

  const grader = getChatModel(0).withStructuredOutput(schema, { name: "grade_sources" });

  try {
    const result = await grader.invoke([
      new SystemMessage(
        [
          "You are a strict retrieval evaluator for a document QA system.",
          "Grade how well each numbered source can help answer the user's question.",
          "Judge relevance only — do not use outside knowledge. Return a verdict for every source.",
          'Use "correct" only when the source clearly contains information that answers or directly supports the question.'
        ].join("\n")
      ),
      new HumanMessage(`Question: ${question}\n\nSources:\n${numbered}`)
    ]);

    const grades: Grade[] = chunks.map(() => "incorrect");
    for (const verdict of result.verdicts) {
      const idx = verdict.rank - 1;
      if (idx >= 0 && idx < grades.length) {
        grades[idx] = verdict.grade;
      }
    }
    return grades;
  } catch {
    // If grading fails, fall back to treating everything as ambiguous so we
    // still attempt a grounded answer rather than dropping the chunks.
    return chunks.map(() => "ambiguous");
  }
}

// Corrective action: rewrite the question into alternative standalone search
// queries (synonym expansion / decomposition), avoiding queries already tried.
async function rewriteQuery(question: string, priorQueries: string[]): Promise<string[]> {
  const schema = z.object({
    queries: z
      .array(z.string())
      .describe("1-3 alternative standalone search queries that could retrieve relevant passages")
  });

  const rewriter = getChatModel(0.3).withStructuredOutput(schema, { name: "rewrite_query" });

  try {
    const result = await rewriter.invoke([
      new SystemMessage(
        [
          "You improve search queries for a document retrieval system.",
          "Rewrite the user's question into 1-3 alternative standalone queries that may match the document better.",
          "Expand synonyms, use domain terms, or split a compound question into focused sub-queries.",
          "Do not answer the question. Do not repeat queries that were already tried."
        ].join("\n")
      ),
      new HumanMessage(`Original question: ${question}\n\nAlready tried: ${priorQueries.join(" | ")}`)
    ]);

    const seen = new Set(priorQueries.map((q) => q.trim().toLowerCase()));
    return result.queries
      .map((q) => q.trim())
      .filter((q) => q.length > 0 && !seen.has(q.toLowerCase()))
      .slice(0, 3);
  } catch {
    return [];
  }
}

function toSources(chunks: GradedSource[]) {
  return chunks.map((chunk, index) => ({
    rank: index + 1,
    score: chunk.score,
    snippet: chunk.snippet,
    metadata: chunk.metadata,
    grade: chunk.grade
  }));
}

async function generateAnswer(question: string, sources: ReturnType<typeof toSources>) {
  const context = sources
    .map((source) => {
      const label = locationLabel(source.metadata as Record<string, unknown>);
      const labelPart = label ? ` [${label}]` : "";
      return `Source ${source.rank}${labelPart} (score: ${source.score.toFixed(3)}):\n${source.snippet}`;
    })
    .join("\n\n");

  const model = getChatModel(0.2);

  const result = await model.invoke([
    new SystemMessage(
      [
        "You are Mini-NotebookLM, a grounded document assistant.",
        "Base your answer on the retrieved context from the user's document. You may summarize, explain, analyze, or give feedback on that content — but never introduce facts that are not supported by it.",
        "Only if the retrieved context is unrelated to the question and cannot support any answer, say that you cannot find it in the uploaded document.",
        "Prefer concise answers. When citing a fact, append a reference using the bracketed label shown next to each source — e.g. (page 3, lines 12-25) for PDFs or (CSV row 47) for spreadsheets. If a source has no label, you may omit the citation for that fact.",
        `\nRetrieved context:\n${context}`
      ].join("\n")
    ),
    new HumanMessage(question)
  ]);

  return contentToString(result.content);
}

// CRAG orchestrator: retrieve -> grade -> (rewrite + re-retrieve)* -> generate,
// or abstain if no relevant chunk can be found in the document.
export async function answerQuestion(collectionName: string, question: string) {
  const embeddings = await getEmbeddings();
  const store = await QdrantVectorStore.fromExistingCollection(embeddings, getVectorStoreOptions(collectionName));

  const triedQueries: string[] = [question];
  const rewrittenQueries: string[] = [];
  let rewrites = 0;

  // Chunks graded relevant (correct, else ambiguous) — the preferred context.
  let bestRound: GradedSource[] = [];
  // Every chunk we retrieved across all rounds (best score per chunk), used as a
  // soft fallback so we never discard real document content just because the
  // grader was strict about the question's phrasing.
  const pool = new Map<string, GradedSource>();

  let queriesForRound = [question];

  while (true) {
    const matches = await retrieveForQueries(store, queriesForRound, RETRIEVAL_K);
    const grades = await gradeChunks(question, matches);
    const graded: GradedSource[] = matches.map((m, index) => ({
      rank: index + 1,
      score: m.score,
      snippet: m.snippet,
      metadata: m.metadata,
      grade: grades[index] ?? "incorrect"
    }));

    for (const g of graded) {
      const existing = pool.get(g.snippet);
      if (!existing || g.score > existing.score) {
        pool.set(g.snippet, g);
      }
    }

    const correct = graded.filter((g) => g.grade === "correct");
    const ambiguous = graded.filter((g) => g.grade === "ambiguous");

    if (correct.length > 0) {
      bestRound = correct;
      break;
    }

    // Keep the round with the most ambiguous (partial) chunks as a fallback.
    if (ambiguous.length > bestRound.length) {
      bestRound = ambiguous;
    }

    if (rewrites >= MAX_REWRITES) {
      break;
    }

    const newQueries = await rewriteQuery(question, triedQueries);
    if (newQueries.length === 0) {
      break;
    }

    rewrites += 1;
    triedQueries.push(...newQueries);
    rewrittenQueries.push(...newQueries);
    queriesForRound = newQueries;
  }

  // Genuinely nothing in the document (empty/unreadable collection) — abstain.
  if (pool.size === 0) {
    return {
      answer:
        "I cannot find an answer to that in the uploaded document. Try rephrasing your question or asking about something the document covers.",
      sources: [],
      retrieval: {
        status: "not_found" as const,
        rewrites,
        rewrittenQueries,
        verdicts: [] as Array<{ rank: number; score: number; grade: Grade }>
      }
    };
  }

  // The grader approved chunks -> use them. Otherwise fall back to the top
  // retrieved chunks by score and let the generator ground or abstain on them.
  const usedFallback = bestRound.length === 0;
  const selected = usedFallback
    ? Array.from(pool.values()).sort((a, b) => b.score - a.score).slice(0, 4)
    : bestRound;

  const sources = toSources(selected);
  const answer = await generateAnswer(question, sources);

  return {
    answer,
    sources,
    retrieval: {
      status: (rewrites === 0 && !usedFallback ? "grounded" : "corrected") as "grounded" | "corrected",
      rewrites,
      rewrittenQueries,
      verdicts: sources.map((s) => ({ rank: s.rank, score: s.score, grade: s.grade }))
    }
  };
}