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

async function loadSettings() {
  const settings = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  document.getElementById("apiKey").value = settings.apiKey ?? DEFAULT_SETTINGS.apiKey;
  document.getElementById("maxAgeInDays").value = settings.maxAgeInDays ?? DEFAULT_SETTINGS.maxAgeInDays;
  document.getElementById("useCache").checked = settings.useCache ?? DEFAULT_SETTINGS.useCache;
  document.getElementById("cacheTtlHours").value = settings.cacheTtlHours ?? DEFAULT_SETTINGS.cacheTtlHours;
  document.getElementById("darkMode").checked = settings.darkMode ?? DEFAULT_SETTINGS.darkMode;
  applyOptionsPageTheme(document.getElementById("darkMode").checked);
}

async function saveSettings(event) {
  event.preventDefault();

  const apiKey = document.getElementById("apiKey").value.trim();
  const maxAgeInDays = Number(document.getElementById("maxAgeInDays").value);
  const useCache = document.getElementById("useCache").checked;
  const cacheTtlHours = Number(document.getElementById("cacheTtlHours").value);
  const darkMode = document.getElementById("darkMode").checked;

  await chrome.storage.local.set({
    apiKey,
    maxAgeInDays,
    useCache,
    cacheTtlHours,
    darkMode
  });

  applyOptionsPageTheme(darkMode);

  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => {
    status.textContent = "";
  }, 1500);
}

document.getElementById("darkMode").addEventListener("change", (event) => {
  applyOptionsPageTheme(event.target.checked);
});

document.getElementById("settingsForm").addEventListener("submit", saveSettings);
loadSettings().catch((error) => {
  document.getElementById("status").textContent = error.message || String(error);
});
