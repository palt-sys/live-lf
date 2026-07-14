// normalize.js
// Canonical alias mapping (mirrors app.py's _LF_ALIAS_MAP)
const LF_ALIAS_MAP = {
    DXY: "USDX",
    USDX: "USDX",
    XAU: "XAUUSD",
    GOLD: "XAUUSD",
    XAUUSD: "XAUUSD",
    XAG: "XAGUSD",
    SILVER: "XAGUSD",
    XAGUSD: "XAGUSD",
    EUR: "EURUSD",
    EURUSD: "EURUSD",
    GBP: "GBPUSD",
    GBPUSD: "GBPUSD",
    AUD: "AUDUSD",
    AUDUSD: "AUDUSD",
    NZD: "NZDUSD",
    NZDUSD: "NZDUSD",
    CAD: "USDCAD",
    USD: "USD",
    JPY: "USDJPY",
    USDJPY: "USDJPY",
    CHF: "USDCHF",
    USDCHF: "USDCHF",
    BTC: "BTCUSD",
    BTCUSD: "BTCUSD",
    BTCUSD_cl: "BTCUSD_cl",
    ETH: "ETHUSD",
    ETHUSD: "ETHUSD",
    ETHUSD_cl: "ETHUSD_cl",
    DOGE: "DOGEUSD",
    DOGEUSD: "DOGEUSD",
    DOGEUSD_cl: "DOGEUSD_cl",
    XRP: "XRPUSD",
    XRPUSD: "XRPUSD",
    XRPUSD_cl: "XRPUSD_cl",
    TOTAL: "TOTAL",
    SPX: "SPX",
    NQ: "NQ",
    YM: "YM",
};
const ALIAS_VALUES = new Set(Object.values(LF_ALIAS_MAP));
const BASE_PAIRS = new Set(["EUR", "GBP", "AUD", "NZD"]);

/**
 * Normalize a single trading asset the same way app.py's
 * normalize_lf_asset() does, so cache keys line up with the backend.
 */
export function normalizeLfAsset(asset) {
    if (!asset) return "";
    const s = asset.trim().toUpperCase().replace(/\s+/g, "").replace(/\//g, "");
    if (s.endsWith("USD") || s === "USDX" || s === "TOTAL" || ALIAS_VALUES.has(s)) {
        return s;
    }
    if (s in LF_ALIAS_MAP) {
        return LF_ALIAS_MAP[s];
    }
    if (s.length === 3 && /^[A-Z]+$/.test(s)) {
        if (BASE_PAIRS.has(s)) return `${s}USD`;
        return `${s}USD`;
    }
    return s;
}

/**
 * Build a stable, backend-consistent cache key for a /f query.
 */
export function cacheKeyFor(tf, assets) {
    const normalized = assets.map((a) => normalizeLfAsset(a)).sort();
    return `f:${tf}:${normalized.join(",")}`;
}