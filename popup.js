async function applyPopupTheme() {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return;
    }
    const settings = await chrome.storage.local.get(["darkMode"]);
    document.body.classList.toggle("abuseipdb-ui-dark", settings.darkMode === true);
  } catch {
    /* Ignore: popup must still work without theme. */
  }
}

async function sendMessageToBackground(message) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return undefined;
  }
  let lastResponse;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      lastResponse = await chrome.runtime.sendMessage(message);
      if (lastResponse !== undefined) {
        return lastResponse;
      }
    } catch {
      /* Service worker may still be starting (MV3). */
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  return lastResponse;
}

async function main() {
  await applyPopupTheme();

  const summaryEl = document.getElementById("summary");
  const openOptionsButton = document.getElementById("openOptions");
  const clearCacheButton = document.getElementById("clearCache");

  if (!summaryEl || !openOptionsButton || !clearCacheButton) {
    return;
  }

  openOptionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  clearCacheButton.addEventListener("click", async () => {
    const response = await sendMessageToBackground({ type: "CLEAR_CACHE" });
    if (!response?.ok) {
      alert(response?.error || "Could not clear the cache.");
      return;
    }
    await renderSummary(summaryEl);
  });

  await renderSummary(summaryEl);
}

async function renderSummary(target) {
  const response = await sendMessageToBackground({ type: "GET_CACHE_SUMMARY" });
  if (!response?.ok) {
    target.textContent =
      response?.error || "Failed to load cache data. Try reloading the extension.";
    return;
  }

  const summary = response.summary;
  target.innerHTML = `
    <div class="row"><span>Cached IPs</span><strong>${summary.totalCachedIps}</strong></div>
    <div class="row"><span>Checks (total)</span><strong>${summary.totalChecks}</strong></div>
    <div class="row"><span>Last IP</span><strong>${escapeHtml(summary.lastIp || "-")}</strong></div>
    <div class="row"><span>Last check</span><strong>${escapeHtml(formatDate(summary.lastCheckedAt))}</strong></div>
  `;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

main().catch((error) => {
  const summary = document.getElementById("summary");
  if (summary) {
    summary.textContent = error.message || String(error);
  }
});
