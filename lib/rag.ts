import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Document } from "@langchain/core/documents";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
  const loadedDocuments =
    mimeType === "application/pdf"
      ? await new PDFLoader(filePath).load()
      : [
          new Document({
            pageContent: await readFile(filePath, "utf-8"),
            metadata: {
              source: filePath
            }
          })
        ];

  return loadedDocuments.map(
    (doc) =>
      new Document({
        pageContent: doc.pageContent,
        metadata: {
          ...doc.metadata,
          sourceName: originalName,
          mimeType
        }
      })
  );
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
    model: "text-embedding-004"
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
  if (!["application/pdf", "text/plain"].includes(file.type)) {
    throw new Error("Only PDF and plain text files are supported.");
  }

  const tempPath = await storeTemporaryUpload(file);
  const collectionName = buildCollectionName(file.name);

  try {
    const sourceDocuments = await loadFileDocuments(tempPath, file.name, file.type);
    const chunks = await splitter.splitDocuments(sourceDocuments);
    const embeddings = await getEmbeddings();

    await QdrantVectorStore.fromDocuments(chunks, embeddings, getVectorStoreOptions(collectionName));

    return {
      collectionName,
      fileName: file.name,
      chunkCount: chunks.length
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
    .map(
      (source) =>
        `Source ${source.rank} (score: ${source.score.toFixed(3)}):\n${source.snippet}\nMetadata: ${JSON.stringify(source.metadata)}`
    )
    .join("\n\n");

  const model = new ChatGoogleGenerativeAI({
    apiKey: getGeminiApiKey(),
    model: "gemini-1.5-flash",
    temperature: 0.2
  });

  const result = await model.invoke([
    new SystemMessage(
      [
        "You are Mini-NotebookLM, a grounded document assistant.",
        "Answer only with facts that are supported by the retrieved context.",
        "If the context does not contain the answer, say that you cannot find it in the uploaded document.",
        "Prefer concise answers, but include direct references to the source chunks when helpful.",
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