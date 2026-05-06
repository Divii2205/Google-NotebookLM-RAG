function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

export function getGeminiApiKey() {
  return requireEnv("GEMINI_API_KEY");
}

export function getQdrantUrl() {
  return process.env.QDRANT_URL ?? "http://localhost:6333";
}

export function getQdrantApiKey() {
  return process.env.QDRANT_API_KEY || undefined;
}