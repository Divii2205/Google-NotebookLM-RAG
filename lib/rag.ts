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
import { getGeminiApiKey, getQdrantApiKey, getQdrantUrl } from "@/lib/env";

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 180
});

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

export async function answerQuestion(collectionName: string, question: string) {
  const embeddings = await getEmbeddings();
  const store = await QdrantVectorStore.fromExistingCollection(embeddings, getVectorStoreOptions(collectionName));
  const matches = await store.similaritySearchWithScore(question, 4);

  const sources = matches.map(([doc, score], index) => ({
    rank: index + 1,
    score,
    snippet: doc.pageContent,
    metadata: doc.metadata
  }));

  const context = sources
    .map((source) => {
      const label = locationLabel(source.metadata as Record<string, unknown>);
      const labelPart = label ? ` [${label}]` : "";
      return `Source ${source.rank}${labelPart} (score: ${source.score.toFixed(3)}):\n${source.snippet}`;
    })
    .join("\n\n");

  const model = new ChatGoogleGenerativeAI({
    apiKey: getGeminiApiKey(),
    model: "gemini-flash-latest",
    temperature: 0.2
  });

  const result = await model.invoke([
    new SystemMessage(
      [
        "You are Mini-NotebookLM, a grounded document assistant.",
        "Answer only with facts that are supported by the retrieved context.",
        "If the context does not contain the answer, say that you cannot find it in the uploaded document.",
        "Prefer concise answers. When citing a fact, append a reference using the bracketed label shown next to each source — e.g. (page 3, lines 12-25) for PDFs or (CSV row 47) for spreadsheets. If a source has no label, you may omit the citation for that fact.",
        `\nRetrieved context:\n${context}`
      ].join("\n")
    ),
    new HumanMessage(question)
  ]);

  return {
    answer: contentToString(result.content),
    sources
  };
}