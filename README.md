# Mini-NotebookLM

Mini-NotebookLM is a document chat app that lets you upload files, ask questions in plain language, and get answers grounded in the uploaded content.

## About

This project is designed to feel like a lightweight personal research companion. You upload a document, the app understands its structure, and then you can keep asking follow-up questions without losing context.

## What it does

- Drag and drop PDF, TXT, or CSV files into the app
- Chunk the document with a recursive character splitter
- Create Gemini embeddings with `gemini-embedding-001`
- Store and search vectors in Qdrant
- Answer questions with `gemini-1.5-flash` using only retrieved context

## What is RAG?

RAG stands for Retrieval-Augmented Generation. Instead of asking the model to answer from memory alone, the app first retrieves the most relevant parts of your document and then uses those chunks as context for the final answer. That usually makes responses more grounded, more useful, and less likely to hallucinate.

In this app, the flow is:

1. Upload a file.
2. Split it into smaller chunks.
3. Convert the chunks into vectors.
4. Search for the most relevant chunks when you ask a question.
5. Generate an answer using only that retrieved context.

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

1. File upload via the browser
2. Temporary server-side file write
3. Loader selection for PDF, TXT, or CSV
4. Recursive chunking with overlap
5. Gemini embeddings
6. Qdrant storage and similarity search
7. Gemini answer generation grounded in retrieved chunks

## Deployment

This project is Vercel-ready because the app reads all secrets from environment variables and keeps Qdrant access server-side.

Set the same environment variables in Vercel, then point `QDRANT_URL` to your hosted Qdrant instance.