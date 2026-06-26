# Mini-NotebookLM

Mini-NotebookLM is a document chat app that lets you upload files, ask questions in plain language, and get answers grounded in the uploaded content. It uses **Corrective RAG (CRAG)** — retrieval is graded for relevance and self-corrected before an answer is generated.

## About

This project is designed to feel like a lightweight personal research companion. You upload a document, the app understands its structure, and then you can keep asking follow-up questions without losing context.

## What it does

- Drag and drop PDF, TXT, or CSV files into the app
- Chunk the document with a recursive character splitter
- Create Gemini embeddings with `gemini-embedding-001`
- Store and search vectors in Qdrant
- Grade retrieved chunks for relevance and self-correct weak retrieval
- Answer questions with `gemini-flash-latest` using only relevant retrieved context

## What is RAG?

RAG stands for Retrieval-Augmented Generation. Instead of asking the model to answer from memory alone, the app first retrieves the most relevant parts of your document and then uses those chunks as context for the final answer. That usually makes responses more grounded, more useful, and less likely to hallucinate.

## What is Corrective RAG (CRAG)?

Plain RAG always trusts whatever the vector search returns — even when those chunks are only the *least bad* matches. If your question uses different words than the document, or the answer simply isn't there, the model is still handed mediocre context and may hallucinate around it.

Corrective RAG adds a **retrieval evaluator** between retrieval and generation. After chunks are retrieved, a Gemini grader labels each one `correct` (directly answers the question), `ambiguous` (partially related), or `incorrect` (unrelated). Based on that grade the app takes a corrective action:

- **Good retrieval** → generate the answer from the relevant chunks (status: *grounded*).
- **Weak retrieval** → **rewrite the question** into alternative search queries and **re-retrieve** from the same document, up to 2 times (status: *corrected*).
- **Still nothing relevant** → abstain honestly instead of guessing (status: *not found in document*).

This version stays **fully grounded in your uploaded document** — corrections only rewrite the query and search the document again; it never falls back to the open web. The grade of each chunk and any query rewrites are shown in the Sources panel so you can see the correction happen.

The per-question flow is:

1. Embed the question and retrieve the top chunks from Qdrant.
2. Grade every chunk for relevance in a single Gemini call.
3. If no chunk is relevant, rewrite the query and re-retrieve (repeat up to 2×).
4. Generate an answer using only the relevant chunks — or abstain if none are found.

## Local setup

1. Start Qdrant locally:

```bash
docker compose up -d
```

2. Create your environment file from the template:

```bash
copy .env.local.example .env.local
```

3. Install dependencies and start the app:

```bash
npm install
npm run dev
```

Open http://localhost:3000.


## Environment variables

Create a `.env.local` file (never commit it):

```
GEMINI_API_KEY=your_api_key_here
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
```

- `GEMINI_API_KEY` – Get from [Google AI Studio](https://aistudio.google.com/apikey)
- `QDRANT_URL` – For local dev, use `http://localhost:6333`; for hosted, use your instance URL
- `QDRANT_API_KEY` – Required only for hosted Qdrant

**Security:** `.env.local` is in `.gitignore` and never committed. All traffic to Google's API is HTTPS.

## RAG pipeline

**Ingestion**

1. File upload via the browser
2. Temporary server-side file write
3. Loader selection for PDF, TXT, or CSV
4. Recursive chunking with overlap (1000 chars, 180 overlap)
5. Gemini embeddings (`gemini-embedding-001`)
6. Qdrant storage (one collection per uploaded document)

**Corrective retrieval & generation** (per question)

7. Embed the question and retrieve the top `RETRIEVAL_K` (6) chunks from Qdrant
8. Grade all chunks for relevance in one Gemini call (`correct` / `ambiguous` / `incorrect`)
9. If no relevant chunk is found, rewrite the query and re-retrieve — up to `MAX_REWRITES` (2) rounds
10. Generate a grounded, cited answer from the relevant chunks — or abstain if none are found

The CRAG logic lives in `lib/rag.ts` (`gradeChunks`, `rewriteQuery`, `retrieveForQueries`, and the `answerQuestion` orchestrator).

## Deployment

This project is Vercel-ready because the app reads all secrets from environment variables and keeps Qdrant access server-side.

Set the same environment variables in Vercel, then point `QDRANT_URL` to your hosted Qdrant instance.