const DEFAULT_SETTINGS = {
  apiKey: "",
  maxAgeInDays: 30,
  useCache: true,
  cacheTtlHours: 24,
  darkMode: false
};

function applyOptionsPageTheme(darkMode) {
  document.body.classList.toggle("abuseipdb-ui-dark", Boolean(darkMode));
}

function getOptionsValues() {
  return {
    apiKey: document.getElementById("apiKey").value.trim(),
    maxAgeInDays: Number(document.getElementById("maxAgeInDays").value),
    useCache: document.getElementById("useCache").checked,
    cacheTtlHours: Number(document.getElementById("cacheTtlHours").value),
    darkMode: document.getElementById("darkMode").checked
  };
}

function setBusy(isBusy) {
  document.getElementById("testApiKey").disabled = isBusy;
  document.getElementById("saveSettings").disabled = isBusy;
}

function showStatus(message) {
  document.getElementById("status").textContent = message;
}

async function loadSettings() {
  const settings = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  document.getElementById("apiKey").value = settings.apiKey ?? DEFAULT_SETTINGS.apiKey;
  document.getElementById("maxAgeInDays").value = settings.maxAgeInDays ?? DEFAULT_SETTINGS.maxAgeInDays;
  document.getElementById("useCache").checked = settings.useCache ?? DEFAULT_SETTINGS.useCache;
  document.getElementById("cacheTtlHours").value = settings.cacheTtlHours ?? DEFAULT_SETTINGS.cacheTtlHours;
  document.getElementById("darkMode").checked = settings.darkMode ?? DEFAULT_SETTINGS.darkMode;
  applyOptionsPageTheme(document.getElementById("darkMode").checked);
}

async function validateApiKey(apiKey, maxAgeInDays) {
  const response = await chrome.runtime.sendMessage({
    type: "VALIDATE_API_KEY",
    apiKey,
    maxAgeInDays
  });

  if (!response?.ok) {
    throw new Error(response?.error || "API key validation failed.");
  }
}

async function testApiKey() {
  const { apiKey, maxAgeInDays } = getOptionsValues();
  setBusy(true);
  showStatus("Testing API key...");
  try {
    await validateApiKey(apiKey, maxAgeInDays);
    showStatus("API key is valid.");
  } catch (error) {
    showStatus(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function saveSettings(event) {
  event.preventDefault();

  const { apiKey, maxAgeInDays, useCache, cacheTtlHours, darkMode } = getOptionsValues();
  setBusy(true);
  showStatus("Saving settings...");

  try {
    await chrome.storage.local.set({
      apiKey,
      maxAgeInDays,
      useCache,
      cacheTtlHours,
      darkMode
    });

    applyOptionsPageTheme(darkMode);

    if (!apiKey) {
      showStatus("Saved. Add an API key to validate it.");
      return;
    }

    showStatus("Saved. Testing API key...");
    await validateApiKey(apiKey, maxAgeInDays);
    showStatus("Saved. API key is valid.");
  } catch (error) {
    showStatus(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

document.getElementById("darkMode").addEventListener("change", (event) => {
  applyOptionsPageTheme(event.target.checked);
});

document.getElementById("testApiKey").addEventListener("click", () => {
  void testApiKey();
});

document.getElementById("settingsForm").addEventListener("submit", saveSettings);
loadSettings().catch((error) => {
  showStatus(error.message || String(error));
});
