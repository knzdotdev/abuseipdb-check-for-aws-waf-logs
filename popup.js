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
  const scanToggle = document.getElementById("scanToggle");
  const scanToggleHint = document.getElementById("scanToggleHint");

  if (!summaryEl || !openOptionsButton || !clearCacheButton || !scanToggle || !scanToggleHint) {
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

  await initScanToggle(scanToggle, scanToggleHint);

  await renderSummary(summaryEl);
}

async function initScanToggle(toggleInput, hintEl) {
  // Default to enabled if settings are unavailable to avoid surprising the user.
  let enabled = true;
  try {
    const stored = await chrome.storage.local.get(["scanningEnabled"]);
    enabled = stored.scanningEnabled !== false;
  } catch {
    /* Keep default. */
  }

  applyToggleState(toggleInput, hintEl, enabled);

  toggleInput.addEventListener("change", async () => {
    const nextEnabled = toggleInput.checked;
    try {
      await chrome.storage.local.set({ scanningEnabled: nextEnabled });
      applyToggleState(toggleInput, hintEl, nextEnabled);
    } catch (error) {
      // Revert UI if storage write fails.
      toggleInput.checked = !nextEnabled;
      applyToggleState(toggleInput, hintEl, !nextEnabled);
      alert(error?.message || "Could not update the scanning setting.");
    }
  });
}

function applyToggleState(toggleInput, hintEl, enabled) {
  toggleInput.checked = enabled;
  hintEl.textContent = enabled
    ? "Scanning is on. IP icons will appear on AWS Console pages."
    : "Scanning is off. No icons will be injected. Reload AWS tabs if icons linger.";
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
