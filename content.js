const IPV4_REGEX = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
const IPV6_CANDIDATE_REGEX =
  /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,}[0-9A-Fa-f]{0,4}(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){0,3}(?![0-9A-Fa-f:])/g;

const SKIP_TAG_NAMES = new Set([
  "SCRIPT",
  "STYLE",
  "TEXTAREA",
  "NOSCRIPT",
  "IFRAME",
  "CANVAS",
  "SVG"
]);

let activeTooltip = null;
/** @type {(() => void) | null} */
let tooltipViewportCleanup = null;
let scanPending = false;

// Mirrors the `scanningEnabled` storage flag. Treated as enabled until settings load
// so we never block the initial scan on async storage access.
let scanningEnabled = true;
/** @type {MutationObserver | null} */
let domObserver = null;
let textNodeRescanPending = false;
let cloudWatchLogScanPending = false;

const TOOLTIP_MARGIN = 8;
const TOOLTIP_PANEL_MAX_WIDTH = 380;
const AWS_CONSOLE_HOSTNAME = "console.aws.amazon.com";
const AWS_CONSOLE_HOST_SUFFIX = ".console.aws.amazon.com";
const GCP_CONSOLE_HOSTNAME = "console.cloud.google.com";
const CLOUDWATCH_LOG_MESSAGE_SELECTOR = [
  ".log-event-message-wrapper.text-mode",
  ".log-events-table__formatted-message-text-mode",
  ".logs__events__json",
  ".logs__events__json-string"
].join(",");
const isGcpConsole = window.location.hostname === GCP_CONSOLE_HOSTNAME;
const isAwsCloudWatchLogs =
  (window.location.hostname === AWS_CONSOLE_HOSTNAME || window.location.hostname.endsWith(AWS_CONSOLE_HOST_SUFFIX)) &&
  window.location.pathname.includes("/cloudwatch/");
const shouldTrackTextNodeMutations = isGcpConsole || isAwsCloudWatchLogs;

/**
 * Visible viewport bounds for fixed-position UI. Prefers Visual Viewport API when
 * available (pinch-zoom / mobile) over layout viewport (innerWidth/innerHeight).
 */
function getViewportBounds() {
  const vv = window.visualViewport;
  if (vv) {
    return {
      left: vv.offsetLeft,
      top: vv.offsetTop,
      width: vv.width,
      height: vv.height
    };
  }
  return {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight
  };
}

// Text nodes confirmed to contain no IP address in a prior scan; skipped on subsequent passes.
const scannedTextNodes = new WeakSet();
const pendingTextNodeRescans = new Set();

function scheduleScan() {
  if (scanPending) {
    return;
  }
  scanPending = true;
  const run = () => {
    scanPending = false;
    if (!scanningEnabled) {
      return;
    }
    scanDocument();
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 200);
  }
}

function scheduleTextNodeRescan(textNode) {
  if (!shouldTrackTextNodeMutations || textNode.nodeType !== Node.TEXT_NODE) {
    return;
  }

  pendingTextNodeRescans.add(textNode);
  if (textNodeRescanPending) {
    return;
  }

  textNodeRescanPending = true;
  const run = () => {
    textNodeRescanPending = false;
    if (!scanningEnabled) {
      pendingTextNodeRescans.clear();
      return;
    }

    const batch = Array.from(pendingTextNodeRescans);
    pendingTextNodeRescans.clear();
    for (const node of batch) {
      scannedTextNodes.delete(node);
      processTextNode(node);
    }
  };

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 1000 });
  } else {
    setTimeout(run, 100);
  }
}

function scheduleCloudWatchLogScan() {
  if (!isAwsCloudWatchLogs || cloudWatchLogScanPending) {
    return;
  }

  cloudWatchLogScanPending = true;
  const run = () => {
    cloudWatchLogScanPending = false;
    if (!scanningEnabled) {
      return;
    }

    scanCloudWatchLogMessages();
    // CloudWatch can expand a row before all syntax-highlighted JSON spans
    // receive their final text; keep the retry scoped to log message bodies.
    setTimeout(() => {
      if (scanningEnabled) {
        scanCloudWatchLogMessages();
      }
    }, 500);
  };

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 1000 });
  } else {
    setTimeout(run, 100);
  }
}

function isValidIpv6(ip) {
  if (typeof ip !== "string" || !ip.includes(":")) {
    return false;
  }
  if (!/[0-9A-Fa-f]/.test(ip)) {
    return false;
  }

  try {
    // The URL parser gives us a browser-native IPv6 syntax check without
    // maintaining a fragile RFC 4291 regular expression by hand.
    const url = new URL("https://[" + ip + "]/");
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

function findIpMatches(text) {
  const matches = [];

  for (const match of text.matchAll(IPV4_REGEX)) {
    matches.push({
      ip: match[0],
      index: match.index ?? 0
    });
  }

  for (const match of text.matchAll(IPV6_CANDIDATE_REGEX)) {
    const ip = match[0];
    if (isValidIpv6(ip)) {
      matches.push({
        ip,
        index: match.index ?? 0
      });
    }
  }

  const sorted = matches.sort((a, b) => a.index - b.index || b.ip.length - a.ip.length);
  const nonOverlapping = [];
  let lastIndex = 0;

  for (const match of sorted) {
    if (match.index < lastIndex) {
      continue;
    }
    nonOverlapping.push(match);
    lastIndex = match.index + match.ip.length;
  }

  return nonOverlapping;
}

function createIpFragment(text, matches) {
  let lastIndex = 0;
  const fragment = document.createDocumentFragment();

  for (const match of matches) {
    const start = match.index;
    if (start > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
    }
    fragment.appendChild(createIpWrapper(match.ip));
    lastIndex = start + match.ip.length;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  return fragment;
}

function acceptTextNode(node) {
  const parent = node.parentElement;
  if (!parent) {
    return false;
  }
  if (SKIP_TAG_NAMES.has(parent.tagName)) {
    return false;
  }
  if (parent.closest(".abuseipdb-tooltip-root")) {
    return false;
  }
  if (parent.closest(".abuseipdb-ip-wrapper")) {
    return false;
  }
  return true;
}

function scanDocument() {
  scanTextNodes(document.body);
}

function scanTextNodes(root, options = {}) {
  if (!root) {
    return;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return acceptTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  const batch = [];
  let current;
  while ((current = walker.nextNode())) {
    batch.push(current);
  }

  for (let i = batch.length - 1; i >= 0; i -= 1) {
    if (options.force) {
      scannedTextNodes.delete(batch[i]);
    }
    processTextNode(batch[i]);
  }
}

function scanCloudWatchLogMessages() {
  if (!isAwsCloudWatchLogs) {
    return;
  }

  const roots = document.querySelectorAll(CLOUDWATCH_LOG_MESSAGE_SELECTOR);
  for (const root of roots) {
    scanTextNodes(root, { force: true });
  }
}

function processTextNode(textNode) {
  if (!acceptTextNode(textNode)) {
    return;
  }

  if (scannedTextNodes.has(textNode)) {
    return;
  }

  const text = textNode.textContent;
  const matches = findIpMatches(text);
  if (matches.length === 0) {
    scannedTextNodes.add(textNode);
    return;
  }

  textNode.parentNode.replaceChild(createIpFragment(text, matches), textNode);
}

function createIpWrapper(ip) {
  const wrapper = document.createElement("span");
  wrapper.className = "abuseipdb-ip-wrapper";

  const label = document.createElement("span");
  label.className = "abuseipdb-ip-text";
  label.textContent = ip;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "abuseipdb-ip-info";
  button.setAttribute("aria-label", "Check IP with AbuseIPDB");
  button.textContent = "\u24D8";

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openTooltipForIp(ip, wrapper);
  });

  wrapper.appendChild(label);
  wrapper.appendChild(button);
  return wrapper;
}

async function openTooltipForIp(ip, anchor) {
  closeTooltip();

  let darkMode = false;
  try {
    const settingsResp = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (settingsResp?.ok && settingsResp.settings) {
      darkMode = Boolean(settingsResp.settings.darkMode);
    }
  } catch {
    // Use light theme if settings are unavailable.
  }

  const tooltip = document.createElement("div");
  tooltip.className = "abuseipdb-tooltip-root" + (darkMode ? " abuseipdb-theme-dark" : "");
  tooltip.setAttribute("role", "dialog");
  tooltip.setAttribute("aria-label", "AbuseIPDB result");

  const header = document.createElement("div");
  header.className = "abuseipdb-tooltip-header";

  const title = document.createElement("span");
  title.className = "abuseipdb-tooltip-title";
  title.textContent = ip;

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "abuseipdb-close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "\u00D7";
  closeButton.addEventListener("click", () => closeTooltip());

  header.appendChild(title);
  header.appendChild(closeButton);

  const body = document.createElement("div");
  body.className = "abuseipdb-tooltip-body";

  const actions = document.createElement("div");
  actions.className = "abuseipdb-tooltip-actions";

  const viewButton = document.createElement("button");
  viewButton.type = "button";
  viewButton.textContent = "View on AbuseIPDB";
  viewButton.addEventListener("click", () => {
    window.open("https://www.abuseipdb.com/check/" + encodeURIComponent(ip), "_blank", "noopener,noreferrer");
  });

  const recheckButton = document.createElement("button");
  recheckButton.type = "button";
  recheckButton.textContent = "Check again";

  async function runCheck(force) {
    body.innerHTML = `<div class="abuseipdb-loading">${escapeHtml("Loading...")}</div>`;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CHECK_IP",
        ip,
        force
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Unknown error");
      }
      body.innerHTML = formatResult(response.result);
      requestAnimationFrame(() => {
        const result = body.querySelector(".abuseipdb-result");
        if (result) result.classList.add("abuseipdb-result-visible");
      });
    } catch (error) {
      body.innerHTML = `<div class="abuseipdb-error">${escapeHtml(error.message || String(error))}</div>`;
    }
    requestAnimationFrame(() => {
      if (activeTooltip === tooltip) {
        clampToViewport(activeTooltip);
      }
    });
  }

  recheckButton.addEventListener("click", () => {
    void runCheck(true);
  });

  actions.appendChild(viewButton);
  actions.appendChild(recheckButton);

  tooltip.appendChild(header);
  tooltip.appendChild(body);
  tooltip.appendChild(actions);
  document.body.appendChild(tooltip);

  activeTooltip = tooltip;
  positionTooltip(anchor, tooltip);
  attachDrag(tooltip, header);

  function onTooltipViewportChange() {
    if (activeTooltip) {
      clampToViewport(activeTooltip);
    }
  }
  const vpTarget = window.visualViewport ?? window;
  vpTarget.addEventListener("resize", onTooltipViewportChange);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("scroll", onTooltipViewportChange);
  }
  tooltipViewportCleanup = () => {
    vpTarget.removeEventListener("resize", onTooltipViewportChange);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("scroll", onTooltipViewportChange);
    }
  };

  await runCheck(false);
}

function formatResult(result) {
  const score = Number(result.abuseConfidenceScore) || 0;
  const scoreClass = getScoreClass(score);
  const riskLabel = score >= 80 ? "HIGH RISK" : score >= 30 ? "MEDIUM RISK" : "LOW RISK";
  const source = formatSource(result);

  const hostnames = (result.hostnames || []).length > 0 ? result.hostnames.join(", ") : null;

  function row(label, value) {
    if (value === null || value === undefined || value === "" || value === "-") return "";
    return `
      <div class="abuseipdb-row">
        <span class="abuseipdb-label">${escapeHtml(label)}</span>
        <span class="abuseipdb-value">${escapeHtml(String(value))}</span>
      </div>`;
  }

  return `
    <div class="abuseipdb-result">
      <div class="abuseipdb-score ${scoreClass}">
        <span class="abuseipdb-score-number">${escapeHtml(String(score))}</span>
        <span class="abuseipdb-score-label">${escapeHtml(riskLabel)}</span>
      </div>

      <div class="abuseipdb-section">
        ${row("Reports", result.totalReports ?? null)}
        ${row("Distinct Users", result.numDistinctUsers ?? null)}
        ${row("Last reported", formatDate(result.lastReportedAt))}
      </div>

      <div class="abuseipdb-section">
        ${row("Country", result.countryName || result.countryCode || null)}
        ${row("ISP", result.isp || null)}
        ${row("Usage", result.usageType || null)}
        ${row("Domain", result.domain || null)}
        ${row("Hostnames", hostnames)}
      </div>

      <div class="abuseipdb-section abuseipdb-section-meta">
        ${row("Whitelisted", String(result.isWhitelisted))}
        ${row("Checked at", formatDate(result.checkedAt))}
        ${row("Source", source)}
      </div>
    </div>
  `;
}

function getScoreClass(score) {
  const value = Number(score) || 0;
  if (value >= 80) return "abuseipdb-score-high";
  if (value >= 30) return "abuseipdb-score-medium";
  return "abuseipdb-score-low";
}

function closeTooltip() {
  if (tooltipViewportCleanup) {
    tooltipViewportCleanup();
    tooltipViewportCleanup = null;
  }
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
}

function clampToViewport(tooltip) {
  const m = TOOLTIP_MARGIN;

  for (let pass = 0; pass < 4; pass += 1) {
    const b = getViewportBounds();
    const maxRight = b.left + b.width - m;
    const maxBottom = b.top + b.height - m;
    const minLeft = b.left + m;
    const minTop = b.top + m;

    const r = tooltip.getBoundingClientRect();
    let left = parseFloat(tooltip.style.left);
    let top = parseFloat(tooltip.style.top);
    if (Number.isNaN(left)) {
      left = r.left;
    }
    if (Number.isNaN(top)) {
      top = r.top;
    }

    let nextLeft = left;
    let nextTop = top;
    if (r.right > maxRight) {
      nextLeft -= r.right - maxRight;
    }
    if (r.left < minLeft) {
      nextLeft += minLeft - r.left;
    }
    if (r.bottom > maxBottom) {
      nextTop -= r.bottom - maxBottom;
    }
    if (r.top < minTop) {
      nextTop += minTop - r.top;
    }

    tooltip.style.left = `${nextLeft}px`;
    tooltip.style.top = `${nextTop}px`;

    if (nextLeft === left && nextTop === top) {
      break;
    }
  }
}

function positionTooltip(anchor, tooltip) {
  const rect = anchor.getBoundingClientRect();
  const m = TOOLTIP_MARGIN;
  const vp = getViewportBounds();

  let left = rect.left;
  left = Math.min(left, vp.left + vp.width - TOOLTIP_PANEL_MAX_WIDTH - m);
  left = Math.max(vp.left + m, left);

  let top = rect.bottom + m;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;

  void tooltip.offsetHeight;

  const tooltipHeight = tooltip.getBoundingClientRect().height;
  const spaceBelow = vp.top + vp.height - rect.bottom - m;
  const spaceAbove = rect.top - vp.top - m;

  if (tooltipHeight > spaceBelow && tooltipHeight <= spaceAbove) {
    top = rect.top - tooltipHeight - m;
    tooltip.style.top = `${top}px`;
  }

  clampToViewport(tooltip);
}

function attachDrag(tooltip, handle) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".abuseipdb-close")) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) {
      return;
    }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    let left = parseFloat(tooltip.style.left);
    let top = parseFloat(tooltip.style.top);
    if (Number.isNaN(left)) {
      left = tooltip.getBoundingClientRect().left;
    }
    if (Number.isNaN(top)) {
      top = tooltip.getBoundingClientRect().top;
    }
    tooltip.style.left = `${left + dx}px`;
    tooltip.style.top = `${top + dy}px`;
    clampToViewport(tooltip);
  });

  handle.addEventListener("pointerup", () => {
    dragging = false;
  });
  handle.addEventListener("pointercancel", () => {
    dragging = false;
  });
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function formatSource(result) {
  if (result.source !== "cache") {
    return result.source;
  }

  const age = formatCacheAge(result.checkedAt);
  return age ? `cache (${age})` : "cache";
}

function formatCacheAge(value) {
  if (!value) {
    return null;
  }

  const checkedAt = new Date(value).getTime();
  if (Number.isNaN(checkedAt)) {
    return null;
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - checkedAt) / 1000));
  if (ageSeconds < 5) {
    return "just now";
  }
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }

  const units = [
    { label: "d", seconds: 24 * 60 * 60 },
    { label: "h", seconds: 60 * 60 },
    { label: "m", seconds: 60 }
  ];

  for (const unit of units) {
    const valueForUnit = Math.floor(ageSeconds / unit.seconds);
    if (valueForUnit >= 1) {
      return `${valueForUnit}${unit.label} ago`;
    }
  }

  return "just now";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.addEventListener("click", (event) => {
  if (!activeTooltip) {
    return;
  }

  if (!activeTooltip.contains(event.target) && !event.target.closest(".abuseipdb-ip-wrapper")) {
    closeTooltip();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeTooltip) {
    closeTooltip();
  }
});

window.addEventListener(
  "scroll",
  () => {
    if (activeTooltip) {
      clampToViewport(activeTooltip);
    }
  },
  true
);

function isSelfInflictedMutation(mutation) {
  if (mutation.type !== "childList") {
    return false;
  }
  return Array.prototype.some.call(
    mutation.addedNodes,
    (n) =>
      n.nodeType === Node.ELEMENT_NODE &&
      (n.classList.contains("abuseipdb-ip-wrapper") || n.classList.contains("abuseipdb-tooltip-root"))
  );
}

function isTrackedTextMutation(mutation) {
  return shouldTrackTextNodeMutations && mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE;
}

function startObserver() {
  if (domObserver) {
    return;
  }
  domObserver = new MutationObserver((mutations) => {
    if (!scanningEnabled) {
      return;
    }
    let shouldScanDocument = false;
    for (let i = 0; i < mutations.length; i += 1) {
      const mutation = mutations[i];
      if (isSelfInflictedMutation(mutation)) {
        continue;
      }
      if (isTrackedTextMutation(mutation)) {
        scheduleTextNodeRescan(mutation.target);
        continue;
      }
      if (isAwsCloudWatchLogs) {
        scheduleCloudWatchLogScan();
      }
      shouldScanDocument = true;
    }
    if (shouldScanDocument) {
      scheduleScan();
    }
  });

  const observerOptions = {
    childList: true,
    subtree: true
  };
  if (shouldTrackTextNodeMutations) {
    observerOptions.characterData = true;
  }

  domObserver.observe(document.documentElement, observerOptions);
}

/**
 * Restores every injected IP wrapper to its original plain text. Used when the user
 * toggles scanning off so previously decorated pages no longer show the info icon.
 */
function unwrapAllIpWrappers() {
  const wrappers = document.querySelectorAll(".abuseipdb-ip-wrapper");
  for (const wrapper of wrappers) {
    const label = wrapper.querySelector(".abuseipdb-ip-text");
    const ipText = label ? label.textContent : wrapper.textContent;
    const parent = wrapper.parentNode;
    if (!parent) {
      continue;
    }
    parent.replaceChild(document.createTextNode(ipText || ""), wrapper);
    // Merge adjacent text nodes so a future re-scan can work on the combined text.
    parent.normalize();
  }
  closeTooltip();
}

function applyScanningState(nextEnabled) {
  const previous = scanningEnabled;
  scanningEnabled = Boolean(nextEnabled);

  if (previous && !scanningEnabled) {
    unwrapAllIpWrappers();
    return;
  }
  if (!previous && scanningEnabled) {
    scheduleScan();
  }
}

function subscribeToScanningSetting() {
  if (!chrome?.storage?.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.scanningEnabled) {
      return;
    }
    const next = changes.scanningEnabled.newValue;
    applyScanningState(next !== false);
  });
}

async function loadInitialScanningState() {
  try {
    const stored = await chrome.storage.local.get(["scanningEnabled"]);
    // Missing flag is treated as enabled (matches DEFAULT_SETTINGS).
    scanningEnabled = stored.scanningEnabled !== false;
  } catch {
    scanningEnabled = true;
  }
}

async function bootstrap() {
  await loadInitialScanningState();
  subscribeToScanningSetting();
  startObserver();
  if (scanningEnabled) {
    scheduleScan();
    scheduleCloudWatchLogScan();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
