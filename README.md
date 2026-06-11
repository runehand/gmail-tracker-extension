# Gmail Tracker Extension

Chrome Manifest V3 extension for Gmail open tracking.

## Local Setup

1. Run the dashboard/backend separately.
2. Open Chrome `chrome://extensions`.
3. Enable Developer mode.
4. Load unpacked and select this `extension` folder.
5. Open Gmail.
6. Click the extension icon and set the dashboard URL.

Default dashboard URL:

```text
https://gmail-tracker-dashboard.vercel.app
```

For real recipient tracking, use a public HTTPS dashboard URL. Gmail's image proxy cannot fetch `localhost` from a received email.

## Development Behavior

The extension currently inserts a visible 100x100 tracking marker into compose windows so the image is easy to inspect during development. For production, switch it back to a hidden 1x1 image before sending.

The compose marker uses a local placeholder while drafting. The real tracking image URL is activated when Send is clicked, then sender-side Gmail views are reported back to the dashboard so they can be ignored in recipient open counts.
