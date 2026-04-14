import { getOpenAICompatBaseUrlTrimmed, isClaudeOpenAICompatMode } from './claude-openai-env.js';

/**
 * OpenAI-compatible GET /v1/models URL (same suffix rule as claudecode fork).
 */
export function buildOpenAIModelsUrl(rawBase) {
  const base = String(rawBase).replace(/\/+$/, '');
  if (/\/v\d+$/i.test(base)) {
    return `${base}/models`;
  }
  return `${base}/v1/models`;
}

function getModelListAuthHeaders() {
  const token = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (key) {
    return {
      Authorization: `Bearer ${key}`,
      'x-api-key': key
    };
  }
  return null;
}

let modelsListCache = null;
let modelsListInFlight = null;

/**
 * @returns {Promise<{ models: Array<{ id: string, label: string }>, error: string | null }>}
 */
export async function fetchOpenAIModelsList() {
  if (!isClaudeOpenAICompatMode()) {
    return { models: [], error: 'CLAUDE_CODE_USE_OPENAI_COMPAT_API is not enabled' };
  }
  const base = getOpenAICompatBaseUrlTrimmed();
  if (!base) {
    return { models: [], error: 'Set CLAUDE_CODE_OPENAI_BASE_URL or ANTHROPIC_BASE_URL' };
  }
  const headers = getModelListAuthHeaders();
  if (!headers) {
    return { models: [], error: 'Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY' };
  }

  if (modelsListCache) {
    return modelsListCache;
  }
  if (modelsListInFlight) {
    return modelsListInFlight;
  }

  modelsListInFlight = (async () => {
    const url = buildOpenAIModelsUrl(base);
    try {
      const response = await fetch(url, {
        headers: { ...headers, Accept: 'application/json' }
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          models: [],
          error: `Models request failed (${response.status}): ${text.slice(0, 400)}`
        };
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { models: [], error: 'Models response was not JSON' };
      }
      const data = Array.isArray(json.data) ? json.data : [];
      const models = data
        .map((row) => {
          const id = typeof row.id === 'string' ? row.id : null;
          if (!id) return null;
          const label =
            typeof row.name === 'string' && row.name.trim()
              ? row.name.trim()
              : id;
          return { id, label };
        })
        .filter(Boolean);
      const out = { models, error: models.length ? null : 'Gateway returned no models' };
      modelsListCache = out;
      return out;
    } catch (err) {
      return { models: [], error: err?.message || String(err) };
    } finally {
      modelsListInFlight = null;
    }
  })();

  return modelsListInFlight;
}

let modelIdsResolved = false;
let modelIdsCache = [];

/**
 * Used by claude-sdk to pick a default when the UI still has preset ids (sonnet, etc.).
 * @returns {Promise<string[]>}
 */
export async function fetchOpenAIModelIdsOnce() {
  if (modelIdsResolved) {
    return modelIdsCache;
  }
  const { models } = await fetchOpenAIModelsList();
  modelIdsCache = models.map((m) => m.id);
  modelIdsResolved = true;
  return modelIdsCache;
}

export function resetOpenAIModelsCache() {
  modelsListCache = null;
  modelIdsResolved = false;
  modelIdsCache = [];
}
