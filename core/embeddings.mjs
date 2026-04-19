/**
 * embeddings.mjs — Local embedding generation via transformers.js
 *
 * Uses all-MiniLM-L6-v2 (22MB, 384 dimensions) for semantic similarity.
 * Runs entirely on CPU — no GPU required, no API calls, no cost.
 *
 * The model is downloaded once on first use and cached locally.
 */

import { pipeline } from '@xenova/transformers';

let embedder = null;
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;

/**
 * Get or initialize the embedding pipeline.
 * First call downloads the model (~22MB), subsequent calls are instant.
 */
async function getEmbedder() {
  if (embedder) return embedder;
  embedder = await pipeline('feature-extraction', MODEL);
  return embedder;
}

/**
 * Generate an embedding vector for a text string.
 *
 * @param {string} text - Text to embed
 * @returns {Float32Array} 384-dimensional normalized vector
 */
export async function embed(text) {
  const pipe = await getEmbedder();
  // Truncate long text to avoid OOM — model context is 256 tokens
  const truncated = text.length > 1000 ? text.slice(0, 1000) : text;
  const result = await pipe(truncated, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data);
}

/**
 * Generate embeddings for multiple texts in batch.
 *
 * @param {string[]} texts - Array of texts to embed
 * @returns {Float32Array[]} Array of 384-dim normalized vectors
 */
export async function embedBatch(texts) {
  const pipe = await getEmbedder();
  const results = [];
  // Process in small batches to avoid memory pressure
  const batchSize = 16;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map(t =>
      t.length > 1000 ? t.slice(0, 1000) : t
    );
    for (const text of batch) {
      const result = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(new Float32Array(result.data));
    }
  }
  return results;
}

export { DIMS, MODEL };
