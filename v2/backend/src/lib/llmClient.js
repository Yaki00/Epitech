'use strict';
/**
 * Client LLM unique (API compatible OpenAI) pour tout le projet.
 *  - un seul transport : httpFetch (module http/https, compatible Node 16)
 *  - timeout (AbortController), retry + backoff sur 429 / 5xx / réseau / timeout
 *  - limite de concurrence
 *  - cache disque par hash de la requête (déterministe : temperature 0)
 *  - mode mock pour les tests sans IA
 *  - chatJson : parsing robuste + validation + 1 tentative de réparation
 * Les erreurs remontent toujours (jamais de "null on error" silencieux).
 */
const fs = require('fs');
const path = require('path');
const { createLimiter, sleep, backoffDelay } = require('./limiter');
const { httpFetch } = require('./httpFetch');
const { parseLlmJson, validateShape } = require('./json');
const { stableHash } = require('./hash');
const { createLogger } = require('./logger');

class LlmError extends Error {
  constructor(message, { status, retryable = false, body, code, content } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
    this.code = code; // 'empty' | 'truncated' | 'invalid_json' (réponse inexploitable)
    this.content = content;
  }
}

function createLlmClient(cfg, deps = {}) {
  const log = deps.logger || createLogger('llm');
  const fetchFn = deps.fetch || httpFetch;
  const limit = createLimiter(cfg.concurrency || 4);
  const stats = { calls: 0, cacheHits: 0, retries: 0, errors: 0, promptTokens: 0, completionTokens: 0 };
  let jsonModeSupported = cfg.jsonMode !== false;
  let reasoningSupported = true; // coupé si la passerelle refuse reasoning_effort

  const modelFor = (task) => cfg.models?.[task] || task;

  // ---------- cache disque ----------
  const cachePath = (key) => path.join(cfg.cacheDir, key.slice(0, 2), `${key}.json`);
  const cacheGet = (key) => {
    if (!cfg.cacheDir) return undefined;
    try {
      return JSON.parse(fs.readFileSync(cachePath(key), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const cacheSet = (key, value) => {
    if (!cfg.cacheDir) return;
    const p = cachePath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(value));
  };

  // ---------- transport ----------
  async function post(endpoint, body) {
    if (cfg.mock) {
      if (!deps.mockHandler) throw new LlmError('LLM_MOCK actif mais aucun mockHandler fourni');
      return deps.mockHandler(endpoint, body);
    }
    let lastErr;
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      const started = Date.now();
      try {
        const res = await fetchFn(`${cfg.baseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          throw new LlmError(`HTTP ${res.status} sur ${endpoint}`, { status: res.status, retryable, body: text.slice(0, 500) });
        }
        log.debug('appel OK', { endpoint, model: body.model, ms: Date.now() - started });
        return JSON.parse(text);
      } catch (err) {
        const e =
          err instanceof LlmError
            ? err
            : new LlmError(err.name === 'AbortError' ? `Timeout après ${cfg.timeoutMs} ms` : `Erreur réseau : ${err.message}`, {
                retryable: true,
              });
        lastErr = e;
        if (!e.retryable || attempt === cfg.maxRetries) break;
        stats.retries++;
        const delay = backoffDelay(attempt, deps.backoffBaseMs ?? 1000);
        log.warn(`nouvel essai ${attempt + 1}/${cfg.maxRetries} dans ${delay} ms`, { endpoint, raison: e.message });
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
    stats.errors++;
    throw lastErr;
  }

  // ---------- API publique ----------
  /**
   * @param {object} p
   * @param {string} p.task        clé de config.models (extract, chat, vision…) ou nom de modèle
   * @param {Array}  p.messages    format OpenAI
   * @param {number} [p.temperature=0]
   * @param {number} [p.maxTokens=2048]
   * @param {boolean}[p.json=false] demande une sortie JSON
   * @param {Array}  [p.tools]     outils (function calling)
   * @param {boolean}[p.cache]     par défaut : actif si temperature === 0 et sans outils
   * @returns {Promise<{content:string, toolCalls:Array, raw:object, cached:boolean}>}
   */
  async function chat({ task = 'chat', messages, temperature = 0, maxTokens = 2048, json = false, tools, cache, validate }) {
    const body = { model: modelFor(task), messages, temperature, max_tokens: maxTokens };
    if (tools) body.tools = tools;
    if (cfg.reasoningEffort && reasoningSupported) body.reasoning_effort = cfg.reasoningEffort;
    if (json && jsonModeSupported) body.response_format = { type: 'json_object' };

    // La clé de cache porte sur la demande d'origine, pas sur la place ajustée ci-dessous.
    const useCache = cache ?? (temperature === 0 && !tools);
    const key = useCache ? stableHash({ ep: 'chat', ...body, response_format: undefined }) : null;
    // Modèle qui réfléchit (réglage vide ou refusé) : la réflexion consomme max_tokens, on garantit un minimum.
    const applyFloor = (b) => {
      const floor = cfg.maxTokens?.reasoning;
      if (floor && !(cfg.reasoningEffort && reasoningSupported)) b.max_tokens = Math.max(b.max_tokens, floor);
    };
    applyFloor(body);
    if (key) {
      const hit = cacheGet(key);
      // Une ancienne entrée vide (écrite avant ce contrôle) n'est pas servie.
      if (hit && (hit.content || (hit.toolCalls && hit.toolCalls.length))) {
        stats.cacheHits++;
        return { ...hit, cached: true };
      }
    }

    const callOnce = async (reqBody) => {
      let raw;
      // Passerelle qui refuse un réglage facultatif (reasoning_effort, response_format) : on le coupe pour
      // la suite et on réessaie ; chaque réglage n'est retiré qu'une fois.
      for (;;) {
        try {
          raw = await post('/chat/completions', reqBody);
          break;
        } catch (err) {
          const said = err.status === 400 ? String(err.body || '') : '';
          if (said && reqBody.reasoning_effort !== undefined && /reasoning/i.test(said)) {
            log.warn('reasoning_effort refusé par la passerelle, désactivé pour la suite (le modèle peut réfléchir : réponses plus lentes)');
            reasoningSupported = false;
            delete reqBody.reasoning_effort;
            applyFloor(reqBody);
          } else if (said && reqBody.response_format && /response_format|json/i.test(said)) {
            log.warn('response_format refusé par la passerelle, désactivé pour la suite');
            jsonModeSupported = false;
            delete reqBody.response_format;
          } else throw err;
        }
      }
      const choice = raw?.choices?.[0] || {};
      const msg = choice.message || {};
      stats.promptTokens += raw?.usage?.prompt_tokens || 0;
      stats.completionTokens += raw?.usage?.completion_tokens || 0;
      const result = { content: msg.content ?? '', toolCalls: msg.tool_calls || [], raw: { usage: raw?.usage, model: raw?.model } };
      if (choice.finish_reason === 'length') {
        throw new LlmError(`Réponse coupée (max_tokens ${reqBody.max_tokens} atteint)`, { code: 'truncated', content: result.content });
      }
      if (!String(result.content).trim() && !result.toolCalls.length) {
        throw new LlmError('Réponse vide du modèle (réflexion trop longue ? essayez LLM_REASONING_EFFORT=none)', { code: 'empty' });
      }
      return result;
    };

    return limit(async () => {
      stats.calls++;
      let result;
      try {
        result = await callOnce(body);
      } catch (err) {
        if (err.code !== 'empty' && err.code !== 'truncated') throw err;
        // Une seule nouvelle tentative, avec le double de place (hors essais réseau).
        log.warn(`réponse ${err.code}, nouvel essai avec max_tokens doublé`, { max_tokens: body.max_tokens * 2 });
        stats.calls++;
        try {
          result = await callOnce({ ...body, max_tokens: body.max_tokens * 2 });
        } catch (err2) {
          if (err2.code === 'empty' || err2.code === 'truncated') stats.errors++;
          throw err2;
        }
      }
      if (validate) {
        try {
          validate(result.content);
        } catch (err) {
          throw new LlmError(err.message, { code: 'invalid_json', content: result.content });
        }
      }
      if (key) cacheSet(key, result);
      return { ...result, cached: false };
    });
  }

  /**
   * Appel qui doit renvoyer du JSON valide. Si le parsing ou la validation échoue,
   * on renvoie l'erreur au modèle une seule fois pour qu'il corrige.
   */
  async function chatJson({ schema, ...params }) {
    const validate = (content) => {
      const data = parseLlmJson(content);
      const errors = schema ? validateShape(data, schema) : [];
      if (errors.length) throw new Error(`JSON invalide : ${errors.join(', ')}`);
      return data;
    };
    try {
      const first = await chat({ ...params, json: true, validate });
      return validate(first.content);
    } catch (err) {
      if (err.code !== 'invalid_json') throw err;
      log.warn('JSON invalide, tentative de réparation', { erreur: err.message });
      try {
        const repaired = await chat({
          ...params,
          json: true,
          cache: false,
          validate,
          messages: [
            ...params.messages,
            { role: 'assistant', content: err.content },
            {
              role: 'user',
              content: `Ta réponse n'est pas exploitable (${err.message}). Renvoie UNIQUEMENT l'objet JSON corrigé, sans texte autour.`,
            },
          ],
        });
        return validate(repaired.content);
      } catch (err2) {
        if (err2.code === 'invalid_json') stats.errors++; // empty/truncated déjà comptées dans chat()
        throw err2;
      }
    }
  }

  /** Message utilisateur avec image (format OpenAI multimodal). */
  function imageMessage(prompt, base64, mime = 'image/png') {
    return {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
      ],
    };
  }

  /** Embeddings (endpoint /embeddings compatible OpenAI). */
  async function embed(texts, { task = 'embed' } = {}) {
    const input = Array.isArray(texts) ? texts : [texts];
    return limit(async () => {
      stats.calls++;
      const raw = await post('/embeddings', { model: modelFor(task), input });
      return raw.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    });
  }

  /**
   * Reclassement (endpoint cfg.rerankPath, ex : /rerank) : un score par document, dans l'ordre des documents.
   * Les erreurs remontent (l'appelant décide de garder son ordre).
   */
  async function rerank({ query, documents, task = 'rerank' }) {
    const docs = Array.isArray(documents) ? documents : [];
    if (!docs.length) return [];
    return limit(async () => {
      stats.calls++;
      const raw = await post(cfg.rerankPath || '/rerank', { model: modelFor(task), query, documents: docs });
      const scores = new Array(docs.length).fill(null);
      for (const r of raw?.results || []) {
        if (Number.isInteger(r?.index) && r.index >= 0 && r.index < docs.length && Number.isFinite(r.relevance_score)) scores[r.index] = r.relevance_score;
      }
      if (scores.some((s) => s === null)) throw new LlmError(`Réponse rerank incomplète (${scores.filter((s) => s !== null).length} scores pour ${docs.length} documents)`);
      return scores;
    });
  }

  return {
    chat,
    chatJson,
    embed,
    rerank,
    imageMessage,
    stats,
    modelFor,
    /** Vrai si la passerelle a refusé reasoning_effort (réglage retiré pour la suite). */
    get reasoningRefused() {
      return Boolean(cfg.reasoningEffort) && !reasoningSupported;
    },
  };
}

module.exports = { createLlmClient, LlmError };
