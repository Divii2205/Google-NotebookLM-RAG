# Mini-NotebookLM

Mini-NotebookLM is a NotebookLM-style RAG app built with Next.js App Router, Tailwind CSS, LangChain.js, Google Gemini, and Qdrant.

## What it does

- Drag and drop PDF or TXT files into the app
- Chunk the document with a recursive character splitter
- Create Gemini embeddings with `text-embedding-004`
- Store and search vectors in Qdrant
- Answer questions with `gemini-1.5-flash` using only retrieved context

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

- `GEMINI_API_KEY` for Gemini API access
- `QDRANT_URL` for the vector database endpoint
- `QDRANT_API_KEY` for hosted Qdrant deployments if needed

For local development, `QDRANT_URL` should point to `http://localhost:6333`.

## RAG pipeline

1. File upload via the browser
2. Temporary server-side file write
3. Loader selection for PDF or TXT
4. Recursive chunking with overlap
5. Gemini embeddings
6. Qdrant storage and similarity search
7. Gemini answer generation grounded in retrieved chunks

## Deployment

This project is Vercel-ready because the app reads all secrets from environment variables and keeps Qdrant access server-side.

Set the same environment variables in Vercel, then point `QDRANT_URL` to your hosted Qdrant instance.