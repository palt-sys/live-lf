import { normalizeLfAsset, cacheKeyFor } from './normalize.js';

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

  async updateAll(assets, tf) {
    const maxCandles = Number(this.env.CANDLES || 5000);
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

    if (!anyNew) return;

    const allTs = Object.keys(rowMap).map(Number).sort((a, b) => a - b);
    if (allTs.length > maxCandles) {
      for (const ts of allTs.slice(0, allTs.length - maxCandles)) delete rowMap[ts];
    }
    await this.state.storage.put('rows', rowMap);

    const json = buildJson(rowMap);
    const filename = filenameFor(tf, assets);
    const path = `${this.env.GITHUB_PATH_PREFIX || 'storage/ohlcvcsv/live'}/${filename}`;

    let sha = await this.state.storage.get('sha');
    sha = await this.upsertFile(path, json, sha);
    await this.state.storage.put('sha', sha);
  }

  async upsertFile(path, content, currentSha) {
    const owner = this.env.GITHUB_OWNER;
    const repo = this.env.GITHUB_REPO;
    const branch = this.env.GITHUB_BRANCH || 'main';
    const token = this.env.GITHUB_TOKEN;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'cf-worker',
    };

    if (!currentSha) {
      const getResp = await fetch(`${apiUrl}?ref=${branch}`, { headers });
      if (getResp.ok) currentSha = (await getResp.json()).sha;
      else if (getResp.status !== 404) throw new Error(`GitHub GET failed: ${getResp.status}`);
    }

    const body = {
      message: `Update ${path} - ${new Date().toISOString()}`,
      content: btoa(unescape(encodeURIComponent(content))),
      branch,
    };
    if (currentSha) body.sha = currentSha;

    let putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (putResp.status === 409) {
      const getResp = await fetch(`${apiUrl}?ref=${branch}`, { headers });
      body.sha = getResp.ok ? (await getResp.json()).sha : undefined;
      putResp = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    if (!putResp.ok) throw new Error(`GitHub PUT failed: ${putResp.status} ${await putResp.text()}`);
    return (await putResp.json()).content.sha;
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

function buildJson(rowMap) {
  const sortedTs = Object.keys(rowMap).map(Number).sort((a, b) => a - b);
  const rows = sortedTs.map((ts) => ({
    t: ts,
    ...rowMap[ts],
  }));
  return JSON.stringify(rows);
}

// Filename derived from your shared helper, so it matches keys used elsewhere
function filenameFor(tf, assets) {
  const key = cacheKeyFor(tf, assets); // e.g. "f:1:BTCUSD,EURUSD"
  const safe = key.replace(/:/g, '_').replace(/,/g, '-');
  return `all_live_${safe}.json`;
}

async function fetchCandles(asset, tf, from, to) {
  const apiUrl = `https://my.litefinance.org/chart/get-history?symbol=${asset}&resolution=${tf}&from=${from}&to=${to}`;
  const resp = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`API status ${resp.status} for ${asset}`);
  return resp.json();
}