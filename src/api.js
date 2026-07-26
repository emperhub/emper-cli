import OpenAI from 'openai';
import { CliError, publicError } from './errors.js';
import { normalizeApiUrl } from './config.js';

function endpoint(baseURL, pathname) {
  return `${baseURL.replace(/\/$/, '')}/${String(pathname).replace(/^\//, '')}`;
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new CliError(`Server returned an invalid response (${response.status}).`, { status:response.status });
  }
}

export function createApiClient({ apiKey, baseURL, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  if (!apiKey) throw new CliError('No API key configured. Run "emper login" first.');
  const normalizedBaseURL = normalizeApiUrl(baseURL);
  const openai = new OpenAI({ apiKey, baseURL:normalizedBaseURL, fetch:fetchImpl });

  async function get(pathname, search = {}) {
    const url = new URL(endpoint(normalizedBaseURL, pathname));
    for (const [key, value] of Object.entries(search)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept:'application/json', Authorization:`Bearer ${apiKey}` },
        signal:AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw publicError(error);
    }
    const body = await responseJson(response);
    if (!response.ok) {
      throw publicError(Object.assign(new Error(body?.error?.message || `Request failed (${response.status})`), {
        status:response.status,
        code:body?.error?.code,
      }));
    }
    return body;
  }

  return {
    baseURL:normalizedBaseURL,
    openai,
    me:() => get('me'),
    models:() => get('models'),
    usage:(limit = 20) => get('usage', { limit }),
    async streamChat({ model, messages, maxTokens }) {
      try {
        return await openai.chat.completions.create({
          model,
          messages,
          max_tokens:maxTokens,
          stream:true,
          stream_options:{ include_usage:true },
        });
      } catch (error) {
        throw publicError(error);
      }
    },
  };
}
