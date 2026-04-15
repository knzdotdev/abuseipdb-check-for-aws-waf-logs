# AbuseIPDB Check for AWS WAF Logs

Chrome extension (Manifest V3) that detects **IPv4** addresses in the **AWS Console** and checks them against [AbuseIPDB](https://www.abuseipdb.com/) on demand.

Designed for use with **AWS WAF Sampled Logs** – click the info icon next to any IP address to instantly see its AbuseIPDB reputation score.

## Scope

The extension runs exclusively on `https://*.console.aws.amazon.com/*` and makes API calls only to `https://api.abuseipdb.com/`.

## Installation

The extension is being submitted to the Chrome Web Store. Until approved, install it as an unpacked extension (see below).

## Configuration

All settings are stored locally in your browser profile (via `chrome.storage.local`). No data leaves your browser except the API call to AbuseIPDB.

| Setting | Default | Description |
|---------|---------|-------------|
| API key | – | Your AbuseIPDB API key (required) |
| maxAgeInDays | 30 | Report age limit for AbuseIPDB lookups |
| Cache TTL | 24 h | How long results are cached locally |
| Use cache | on | Skip repeat API calls for known IPs |
| Dark mode | on | Dark theme for tooltip, popup, and options |
