const IPV4_REGEX = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;

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

const TOOLTIP_MARGIN = 8;
const TOOLTIP_PANEL_MAX_WIDTH = 380;

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

// Text nodes confirmed to contain no IPv4 in a prior scan; skipped on subsequent passes.
const scannedTextNodes = new WeakSet();

function scheduleScan() {
  if (scanPending) {
    return;
  }
  scanPending = true;
  const run = () => {
    scanPending = false;
    scanDocument();
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 200);
  }
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
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
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
    processTextNode(batch[i]);
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
  const matches = Array.from(text.matchAll(IPV4_REGEX));
  if (matches.length === 0) {
    scannedTextNodes.add(textNode);
    return;
  }

  let lastIndex = 0;
  const fragment = document.createDocumentFragment();

  for (const match of matches) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
    }
    fragment.appendChild(createIpWrapper(match[0]));
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  textNode.parentNode.replaceChild(fragment, textNode);
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
        ${row("Source", result.source)}
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

function startObserver() {
  const observer = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i += 1) {
      if (!isSelfInflictedMutation(mutations[i])) {
        scheduleScan();
        return;
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function bootstrap() {
  scheduleScan();
  startObserver();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
