# Universal Agent Extension (MV3)

Chrome MV3 extension with a sidepanel UI and background agent powered by Mistral/LangChain.

## Requirements

- Node.js 18+ (recommended: Node 20)
- npm 9+
- Google Chrome (current stable)

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. Load unpacked in Chrome:
- Open `chrome://extensions`
- Enable **Developer mode**
- Click **Load unpacked**
- Select this folder's `dist/` directory:
  - `/Users/an/Documents/voxel/extension/dist`

4. Open the extension:
- Click the extension toolbar icon
- The sidepanel should open with the Universal Agent UI

## What `npm run build` Creates

The build writes a Chrome-loadable MV3 package in `dist/`:

- `dist/manifest.json`
- `dist/background/service-worker.js`
- `dist/sidepanel/panel.html`
- `dist/sidepanel/panel.js`
- `dist/sidepanel/panel.css`
- `dist/content/bridge.js`
- `dist/content/capture.js`
- `dist/content/executor.js`
- `dist/lib/selector.js`
- `dist/options/options.html`
- `dist/options/options.js`

Use `dist/` as the unpacked extension root.

## API Keys

This extension reads API keys from Chrome extension local storage (set via the options page), not directly from process env vars at runtime.

Required keys:
- `mistral_api_key`
- `elevenlabs_api_key`

### Set keys in UI (recommended)

1. In `chrome://extensions`, find **Universal Agent**
2. Click **Details**
3. Click **Extension options**
4. Enter and save:
   - Mistral API key
   - ElevenLabs API key

### Optional shell exports (convenience only)

If you want shell variables while developing:

```bash
export MISTRAL_API_KEY="your_mistral_key"
export ELEVENLABS_API_KEY="your_elevenlabs_key"
```

These are not automatically consumed by the extension. You still need to paste keys in Extension options.

## Development Loop

After code changes:

```bash
npm run build
```

Then in `chrome://extensions` click **Reload** for the extension.

## Troubleshooting

### Icon click does nothing

- Ensure you loaded `dist/` (not a subfolder)
- Rebuild and reload extension:

```bash
npm run build
```

- Open service worker logs from extension Details and check for runtime errors

### Build error about `node:async_hooks`

If this reappears, verify browser code does **not** import `@langchain/langgraph` root directly for checkpointing. Use:

- `MemorySaver` from `@langchain/langgraph-checkpoint`

### Sidepanel not rendering

- Confirm `dist/sidepanel/panel.html` exists
- Confirm `dist/manifest.json` has:
  - `"side_panel": { "default_path": "sidepanel/panel.html" }`
