import { normalizeLfAsset } from './normalize.js';

export class PollerDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async alarm() {
    const rawAssets = this.env.ASSETS.split(',').map((s) => s.trim());
    const assets = rawAssets.map(normalizeLfAsset);
    const tf = this.env.TF || '1';

    try {
      await this.resetIfConfigChanged(assets, tf);
      await this.updateAll(assets, tf);
      await this.state.storage.put('lastError', null);
    } catch (err) {
      console.error('Update failed:', err.message);
      await this.state.storage.put('lastError', err.message);
    }

    await this.state.storage.put('lastRun', new Date().toISOString());

    const running = await this.state.storage.get('running');
    if (running !== false) {
      const interval = Number(this.env.INTERVAL_MS || 10000);
      await this.state.storage.setAlarm(Date.now() + interval);
    }
  }

  // Wipes local rows + per-asset watermarks whenever the ASSETS list or
  // TF changes (including the very first cycle after this check was
  // added, since pre-existing storage may already hold dirty/mixed
  // rows from before this feature existed) — so old/removed assets
  // never linger in the output file and the next cycle does a clean
  // full backfill under the current config.
  async resetIfConfigChanged(assets, tf) {
    const sortedAssets = [...assets].sort();
    const currentKey = `${tf}|${sortedAssets.join(',')}`;
    const prevKey = await this.state.storage.get('trackedConfigKey');

    if (prevKey === currentKey) return; // config unchanged, nothing to do

    console.log(
      `Config fingerprint changed or unset (was "${prevKey}", now "${currentKey}") — resetting local state for a clean rebuild.`
    );

    await this.state.storage.delete('rows');
    await this.state.storage.delete('sha');

    // Enumerate every ts-* watermark currently in storage (not just ones
    // we happen to remember) so nothing from an old/unknown config lingers.
    const tsEntries = await this.state.storage.list({ prefix: 'ts-' });
    const tsKeys = [...tsEntries.keys()];
    if (tsKeys.length) await this.state.storage.delete(tsKeys);

    await this.state.storage.put('trackedConfigKey', currentKey);
    await this.state.storage.put('trackedAssets', sortedAssets);
  }

  async updateAll(assets, tf) {
    const maxCandles = Number(this.env.CANDLES || 10000);
    const nowSec = Math.floor(Date.now() / 1000);

    const results = await Promise.all(
      assets.map(async (asset) => {
        const lastTs = (await this.state.storage.get(`ts-${asset}`)) || 0;
        const from = lastTs > 0 ? lastTs + 1 : nowSec - Number(tf) * 60 * maxCandles;
        const data = await fetchCandles(asset, tf, from, nowSec);
        return { asset, data, lastTs };
      })
    );

    // rowMap: { [timestamp]: { BTCUSD: {open,high,low,close,volume}, EURUSD: {...} } }
    let rowMap = (await this.state.storage.get('rows')) || {};
    let anyNew = false;

    for (const { asset, data, lastTs } of results) {
      const { t = [], o = [], h = [], l = [], c = [], v = [] } = data;
      console.log(
        `asset=${asset} lastTs=${lastTs} candlesReceived=${t.length} newest=${t[t.length - 1]}`
      );
      let maxTs = lastTs;
      for (let i = 0; i < t.length; i++) {
        if (t[i] <= lastTs) continue;
        anyNew = true;
        const row = rowMap[t[i]] || {};
        row[asset] = { open: o[i], high: h[i], low: l[i], close: c[i], volume: v[i] };
        rowMap[t[i]] = row;
        if (t[i] > maxTs) maxTs = t[i];
      }
      await this.state.storage.put(`ts-${asset}`, maxTs);
    }

    if (!anyNew) {
      console.log('No new candles this cycle — pushing anyway (always-push mode).');
    }

    const allTs = Object.keys(rowMap).map(Number).sort((a, b) => a - b);
    if (allTs.length > maxCandles) {
      for (const ts of allTs.slice(0, allTs.length - maxCandles)) delete rowMap[ts];
    }
    await this.state.storage.put('rows', rowMap);

    const json = buildJson(rowMap);
    const filename = filenameFor();
    const path = `${this.env.GITHUB_PATH_PREFIX || 'storage/ohlcvcsv/live'}/${filename}`;
    console.log(`Writing to path: ${path}`);

    let sha = await this.state.storage.get('sha');
    sha = await this.upsertFileWithRetry(path, json, sha);
    await this.state.storage.put('sha', sha);
    console.log(`GitHub push succeeded, new sha=${sha}`);
  }

  // Wraps upsertFile with a small bounded retry/backoff for transient
  // failures (network blips, GitHub secondary rate limits, etc).
  // Does NOT retry on clear permanent failures like 401/403 auth errors.
  async upsertFileWithRetry(path, content, currentSha, maxAttempts = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.upsertFile(path, content, currentSha);
      } catch (err) {
        lastErr = err;
        const msg = err.message || '';
        const isAuthError = /GitHub (GET|PUT) failed: 401|GitHub (GET|PUT) failed: 403/.test(msg);
        if (isAuthError || attempt === maxAttempts) {
          throw err;
        }
        const backoffMs = 500 * 2 ** (attempt - 1); // 500ms, 1000ms, ...
        console.error(
          `upsertFile attempt ${attempt} failed: ${msg} — retrying in ${backoffMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw lastErr;
  }

  async upsertFile(path, content, currentSha) {
    const owner = this.env.GITHUB_OWNER;
    const repo = this.env.GITHUB_REPO;
    const branch = this.env.GITHUB_BRANCH || 'main';
    const token = this.env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      throw new Error(
        `GitHub config missing (owner=${!!owner}, repo=${!!repo}, token=${!!token})`
      );
    }

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'cf-worker',
    };
    const timeoutMs = 10000;

    if (!currentSha) {
      const getResp = await fetchWithTimeout(`${apiUrl}?ref=${branch}`, { headers }, timeoutMs);
      if (getResp.ok) {
        currentSha = (await getResp.json()).sha;
      } else if (getResp.status !== 404) {
        throw new Error(`GitHub GET failed: ${getResp.status} ${await safeText(getResp)}`);
      }
    }

    const body = {
      message: `Update ${path} - ${new Date().toISOString()}`,
      content: btoa(unescape(encodeURIComponent(content))),
      branch,
    };
    if (currentSha) body.sha = currentSha;

    let putResp = await fetchWithTimeout(
      apiUrl,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs
    );

    if (putResp.status === 409) {
      console.error('GitHub PUT got 409 (stale sha) — refetching sha and retrying once.');
      const getResp = await fetchWithTimeout(`${apiUrl}?ref=${branch}`, { headers }, timeoutMs);
      if (!getResp.ok) {
        throw new Error(
          `GitHub GET (409 recovery) failed: ${getResp.status} ${await safeText(getResp)}`
        );
      }
      body.sha = (await getResp.json()).sha;
      putResp = await fetchWithTimeout(
        apiUrl,
        {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs
      );
    }

    if (!putResp.ok) {
      throw new Error(`GitHub PUT failed: ${putResp.status} ${await safeText(putResp)}`);
    }

    const putJson = await putResp.json();
    if (!putJson?.content?.sha) {
      throw new Error(
        `GitHub PUT succeeded but response missing content.sha: ${JSON.stringify(putJson)}`
      );
    }
    return putJson.content.sha;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/start') {
      await this.state.storage.put('running', true);
      await this.state.storage.setAlarm(Date.now());
      return new Response('started');
    }
    if (url.pathname === '/stop') {
      await this.state.storage.put('running', false);
      await this.state.storage.deleteAlarm();
      return new Response('stopped');
    }
    if (url.pathname === '/status') {
      const [running, lastRun, lastError] = await Promise.all([
        this.state.storage.get('running'),
        this.state.storage.get('lastRun'),
        this.state.storage.get('lastError'),
      ]);
      return new Response(JSON.stringify({ running, lastRun, lastError }, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('PollerDO. Use /start, /stop, /status');
  }
}

// Reads response text without throwing if the body can't be read for
// some reason — used purely for building useful error messages.
async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return '<no body>';
  }
}

// fetch() with a hard timeout so a hung GitHub API call can't stall
// the alarm handler indefinitely.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildJson(rowMap) {
  const sortedTs = Object.keys(rowMap).map(Number).sort((a, b) => a - b);
  const rows = sortedTs.map((ts) => ({
    t: ts,
    ...rowMap[ts],
  }));
  return JSON.stringify(rows);
}

// Fixed filename — always the same file, always overwritten in place.
function filenameFor() {
  return `all_alive.json`;
}

async function fetchCandles(asset, tf, from, to) {
  const apiUrl = `https://my.litefinance.org/chart/get-history?symbol=${asset}&resolution=${tf}&from=${from}&to=${to}`;
  const resp = await fetchWithTimeout(apiUrl, { headers: { Accept: 'application/json' } }, 10000);
  if (!resp.ok) throw new Error(`API status ${resp.status} for ${asset}`);
  const body = await resp.json();
  if (body.status === 'error') {
    throw new Error(`LiteFinance error for ${asset}: ${body.code}`);
  }
  if (!body.data) {
    throw new Error(`LiteFinance response missing data for ${asset}: ${JSON.stringify(body)}`);
  }
  return body.data; // { o, h, l, c, v, t } — actual candle arrays live here
}