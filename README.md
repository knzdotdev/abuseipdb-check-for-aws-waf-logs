# IP Check for WAF Logs

Chrome extension (Manifest V3) that detects **IPv4** addresses in the
**AWS Console** and checks them against
[AbuseIPDB](https://www.abuseipdb.com/) on demand.

Designed for use with **AWS WAF Sampled Logs** — click the info icon
next to any IP address to instantly see its AbuseIPDB reputation score,
report counts, country, ISP, and other context.

## Purpose

Speed up IP triage during AWS WAF investigations without leaving the
console. Instead of copying addresses into a separate AbuseIPDB tab, the
extension renders an inline info control next to every detected IPv4
address and surfaces the reputation score in a compact tooltip.

## Scope

- Runs **only** on `https://*.console.aws.amazon.com/*`.
- Makes network requests **only** to `https://api.abuseipdb.com/*`.
- IPv4 detection only in v0.1.0. IPv6 support is on the roadmap.
- No telemetry, no analytics, no remote configuration. All data stays
  in your browser profile (`chrome.storage.local`); see
  [Security notes](#security-notes) below.

## How to run / install

The extension is being prepared for the Chrome Web Store. Until the
listing is approved, install it as an unpacked extension:

```bash
git clone <repo-url>
cd abuseipdb-check-for-aws-waf-logs
```

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this repository's root folder.
4. Open the extension's options page and paste your AbuseIPDB API key.
5. Visit any page under `https://*.console.aws.amazon.com/` — detected
   IPv4 addresses will show a small info icon.

There is no build step; the extension ships from source.

Signed release ZIPs are published as
[GitHub Releases](../../releases) together with a SHA-256 checksum file
for integrity verification (see [Security notes](#security-notes)).

## Configuration

All settings are stored locally in your browser profile (via
`chrome.storage.local`). No data leaves your browser except the API
call to AbuseIPDB.

| Setting        | Default | Description                                                        |
| -------------- | ------- | ------------------------------------------------------------------ |
| API key        | —       | Your AbuseIPDB API key (required). Get one at https://www.abuseipdb.com/account/api. |
| `maxAgeInDays` | 30      | Report age limit forwarded to the AbuseIPDB `check` endpoint.       |
| Cache TTL      | 24 h    | How long results are cached locally before a re-lookup is issued.   |
| Use cache      | on      | Skip repeat API calls for already-known IPs while the TTL is fresh. |
| Dark mode      | on      | Dark theme for the tooltip, popup, and options page.                |

Use the **Check again** button in the tooltip to force a fresh lookup
that bypasses the cache.

## Troubleshooting

| Symptom                                                                   | Likely cause                                         | Fix                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tooltip shows "No AbuseIPDB API key configured".                          | Options page has no key set.                         | Open the extension options and paste your key.                                                                  |
| Tooltip shows `AbuseIPDB API error 401` or `403`.                         | Key is invalid, revoked, or hit rate limit.          | Verify the key in the AbuseIPDB dashboard; check daily quota.                                                   |
| Info icon does not appear next to IPs in a WAF log view.                  | Content script did not re-scan the dynamic content.  | Scroll the log view or reload the page; the MutationObserver will pick up the new nodes.                        |
| Popup shows "Failed to load cache data. Try reloading the extension."     | MV3 service worker cold-start race.                  | Reopen the popup (it already retries 3×); if it persists, reload the extension from `chrome://extensions`.      |
| Extension icon is disabled / no effect.                                   | Tab is not on an AWS Console origin.                 | The content script only runs on `https://*.console.aws.amazon.com/*` — navigate to a matching page.             |
| IPv6 addresses are ignored.                                               | By design in v0.1.0.                                 | IPv6 support is on the roadmap.                                                                                 |

## Security notes

- The AbuseIPDB API key is the most sensitive data the extension
  handles. It is stored only in `chrome.storage.local` on the user's
  device and never synced across browser profiles.
- Network egress is limited to `https://api.abuseipdb.com/*` (enforced
  via `host_permissions` in `manifest.json`).
- No logs, no telemetry, no third-party calls.
- Release artifacts are published with a SHA-256 checksum. Verify a
  downloaded ZIP before loading it:

  ```bash
  # macOS / Linux
  shasum -a 256 abuseipdb-ip-checker-v<version>.zip

  # Windows (PowerShell)
  Get-FileHash abuseipdb-ip-checker-v<version>.zip -Algorithm SHA256
  ```

  Compare the output against the hash published inline in the matching
  GitHub Release notes.

## Changelog

### 0.2.2

- Renamed the extension display name to **IP Check for WAF Logs** to keep
  third-party trademark references descriptive rather than prominent in
  the product title.

### 0.2.1

- Updated the Chrome extension icon assets.

### 0.2.0

- Added a popup toggle to enable or disable inline IP scanning.
- Keeps scanning enabled by default and stores the preference locally in
  `chrome.storage.local`.

### 0.1.0

- Initial Manifest V3 extension release.
- Detects IPv4 addresses on AWS Console pages and checks them against
  AbuseIPDB on demand using the user's API key.
- Stores settings and cached lookup results locally only.

## Disclaimer

This extension is an independent, unofficial tool and is not affiliated
with, endorsed by, or associated with AbuseIPDB or Amazon Web Services
(AWS) in any way. "AWS" and "AbuseIPDB" are trademarks of their
respective owners.
