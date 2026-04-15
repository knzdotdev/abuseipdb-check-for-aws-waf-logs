const DEFAULT_SETTINGS = {
  apiKey: "",
  maxAgeInDays: 30,
  useCache: true,
  autoBadge: false,
  cacheTtlHours: 24,
  darkMode: true
};

const CACHE_PREFIX = "ipcache:";
const META_KEY = "meta";

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const updates = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof current[key] === "undefined") {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message && message.type === "GET_SETTINGS") {
        const settings = await getSettings();
        sendResponse({ ok: true, settings: settings });
        return;
      }

      if (message && message.type === "CHECK_IP") {
        const result = await checkIp(message.ip, Boolean(message.force));
        sendResponse({ ok: true, result: result });
        return;
      }

      if (message && message.type === "GET_CACHE_ENTRY") {
        const entry = await getCacheEntry(message.ip);
        sendResponse({ ok: true, entry: entry });
        return;
      }

      if (message && message.type === "GET_CACHE_SUMMARY") {
        const summary = await getCacheSummary();
        sendResponse({ ok: true, summary: summary });
        return;
      }

      if (message && message.type === "CLEAR_CACHE") {
        const removed = await clearCache();
        sendResponse({ ok: true, removed: removed });
        return;
      }

      sendResponse({ ok: false, error: "Unsupported message type." });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  })();

  return true;
});

async function getSettings() {
  const settings = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return {
    ...DEFAULT_SETTINGS,
    ...settings
  };
}

function getCacheKey(ip) {
  return CACHE_PREFIX + ip;
}

function isFresh(entry, ttlHours) {
  if (!entry || !entry.checkedAt) {
    return false;
  }

  const ageMs = Date.now() - new Date(entry.checkedAt).getTime();
  return ageMs < ttlHours * 60 * 60 * 1000;
}

async function getCacheEntry(ip) {
  const key = getCacheKey(ip);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function setCacheEntry(ip, payload) {
  const key = getCacheKey(ip);
  await chrome.storage.local.set({ [key]: payload });
  await updateMeta(ip, payload.checkedAt);
}

async function updateMeta(lastIp, checkedAt) {
  const data = await chrome.storage.local.get(META_KEY);
  const meta = data[META_KEY] || {
    lastIp: null,
    lastCheckedAt: null,
    totalChecks: 0
  };

  meta.lastIp = lastIp;
  meta.lastCheckedAt = checkedAt;
  meta.totalChecks += 1;

  await chrome.storage.local.set({ [META_KEY]: meta });
}

async function getCacheSummary() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX));
  const entries = keys.map((key) => all[key]).filter(Boolean);
  const meta = all[META_KEY] || {
    lastIp: null,
    lastCheckedAt: null,
    totalChecks: 0
  };

  return {
    totalCachedIps: entries.length,
    totalChecks: meta.totalChecks || 0,
    lastIp: meta.lastIp || null,
    lastCheckedAt: meta.lastCheckedAt || null,
    entries: entries
      .sort((a, b) => new Date(b.checkedAt).getTime() - new Date(a.checkedAt).getTime())
      .slice(0, 20)
  };
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX));

  if (cacheKeys.length > 0) {
    await chrome.storage.local.remove(cacheKeys);
  }

  await chrome.storage.local.remove(META_KEY);

  return cacheKeys.length;
}

async function checkIp(ip, force) {
  validateIpv4(ip);

  const settings = await getSettings();

  if (!settings.apiKey) {
    throw new Error(
      "No AbuseIPDB API key configured. Add your key in the extension options."
    );
  }

  const cached = await getCacheEntry(ip);
  if (
    !force &&
    settings.useCache &&
    cached &&
    isFresh(cached, Number(settings.cacheTtlHours))
  ) {
    return {
      ...cached,
      source: "cache"
    };
  }

  const url = new URL("https://api.abuseipdb.com/api/v2/check");
  url.searchParams.set("ipAddress", ip);
  url.searchParams.set("maxAgeInDays", String(settings.maxAgeInDays));
  url.searchParams.set("verbose", "true");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Key: settings.apiKey
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("AbuseIPDB API error " + response.status + ": " + text);
  }

  const json = await response.json();
  const data = json && json.data;

  if (!data) {
    throw new Error("Invalid response from AbuseIPDB.");
  }

  const normalized = {
    ip: ip,
    checkedAt: new Date().toISOString(),
    source: "api",
    abuseConfidenceScore: data.abuseConfidenceScore,
    countryCode: data.countryCode || null,
    countryName: data.countryName || null,
    usageType: data.usageType || null,
    isp: data.isp || null,
    domain: data.domain || null,
    hostnames: Array.isArray(data.hostnames) ? data.hostnames : [],
    isPublic: data.isPublic,
    isWhitelisted: data.isWhitelisted,
    totalReports: data.totalReports,
    numDistinctUsers: data.numDistinctUsers,
    lastReportedAt: data.lastReportedAt || null,
    raw: data
  };

  await setCacheEntry(ip, normalized);
  return normalized;
}

function validateIpv4(ip) {
  const ipv4Regex =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

  if (!ipv4Regex.test(ip)) {
    throw new Error("Invalid IPv4 address: " + ip);
  }
}