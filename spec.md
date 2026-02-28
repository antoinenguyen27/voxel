# Universal Agent — Full End-to-End Technical Specification

**Stack:** MV3 Chrome Extension · LangGraph JS · Mistral Large · Voxtral Realtime · ElevenLabs  
**Version:** 1.0 — Hackathon Build Spec

---

## 1. System Overview

The Universal Agent is a Chrome extension with two modes:

- **Demo Mode** — User narrates + performs actions on any website. The agent observes, captures DOM/network events, pairs them with the voice transcript, and writes structured `SKILL.md` files via Mistral Large.
- **Work Mode** — User gives a voice instruction. The agent transcribes it, plans a task using LangGraph, looks up relevant skills, writes targeted execution code, runs it in the page, and responds via ElevenLabs TTS. Each task appends to a session `memory.md`. The loop terminates cleanly after each ElevenLabs playback completes.

---

## 2. File Structure

```
extension/
├── manifest.json
├── background/
│   └── service-worker.js        # MV3 service worker — LangGraph orchestration lives here
├── content/
│   ├── capture.js               # MAIN world — event + network capture (demo mode)
│   ├── executor.js              # MAIN world — receives and runs execution code
│   └── bridge.js                # ISOLATED world — chrome.runtime ↔ MAIN world relay
├── sidepanel/
│   ├── panel.html
│   ├── panel.js                 # UI, mic, mode toggle, ElevenLabs playback
│   └── panel.css
├── skills/
│   └── (generated SKILL.md files, stored in chrome.storage.local)
└── lib/
    └── selector.js              # Stable selector generation (shared utility)
```

---

## 3. Manifest (MV3)

```json
{
  "manifest_version": 3,
  "name": "Universal Agent",
  "version": "1.0.0",
  "permissions": [
    "activeTab",
    "scripting",
    "storage",
    "sidePanel",
    "tabs"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/bridge.js"],
      "run_at": "document_start",
      "all_frames": true
    }
  ],
  "side_panel": {
    "default_path": "sidepanel/panel.html"
  },
  "action": {
    "default_title": "Universal Agent"
  },
  "web_accessible_resources": [
    {
      "resources": ["content/capture.js", "content/executor.js", "lib/selector.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

**Key decisions:**
- `bridge.js` runs in the **isolated world** (default). It has `chrome.runtime` access and relays messages to/from the MAIN world scripts via `window.postMessage`.
- `capture.js` and `executor.js` are **not** declared as content scripts — they are injected programmatically into the **MAIN world** on demand, so they can access and patch the page's own JS (fetch, XHR, framework internals).
- `all_frames: true` on `bridge.js` ensures iframes also get a relay bridge.

---

## 4. MAIN World Injection

The service worker injects capture/executor into the MAIN world when a session starts:

```javascript
// background/service-worker.js
async function injectMainWorldScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['lib/selector.js'],
    world: 'MAIN'
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/capture.js'],
    world: 'MAIN'
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/executor.js'],
    world: 'MAIN'
  });
}
```

> **Bug risk:** `chrome.scripting.executeScript` with `world: 'MAIN'` requires the `scripting` permission and the tab to have a real URL (not `chrome://` pages or the new tab page). Always guard with a URL check before injecting. Also, re-injection on navigation: listen to `chrome.tabs.onUpdated` with `status === 'complete'` and re-inject if a session is active.

---

## 5. Bridge Script (Isolated World ↔ MAIN World)

```javascript
// content/bridge.js — runs in ISOLATED world

// MAIN → Extension: relay captured events to service worker
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data?.__universalAgent) return;
  chrome.runtime.sendMessage(event.data);
});

// Extension → MAIN: relay execution commands to executor
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'EXECUTE_CODE' || message.type === 'PING') {
    window.postMessage({ __universalAgent: true, ...message }, '*');
  }
});
```

> **Bug risk:** The `event.source !== window` check is critical — without it, messages from iframes or other sources will leak through. Also, `chrome.runtime.onMessage` listeners that return `true` indicate async response; if you don't need async, don't return `true` or you'll keep the channel open indefinitely, which causes memory leaks in service workers.

---

## 6. Stable Selector Generation (`lib/selector.js`)

This is shared between capture and executor. Priority order:

```javascript
// lib/selector.js — injected into MAIN world

window.__getStableSelector = function(el) {
  if (!el || el.nodeType !== 1) return null;

  // 1. aria-label (most stable across re-renders)
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const tag = el.tagName.toLowerCase();
    const candidate = `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
    if (document.querySelectorAll(candidate).length === 1) return candidate;
  }

  // 2. data-* attributes that look like stable IDs
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-') && 
        (attr.name.includes('id') || attr.name.includes('key') || attr.name.includes('testid'))) {
      const candidate = `[${attr.name}="${CSS.escape(attr.value)}"]`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
  }

  // 3. Non-generated ID (skip IDs that look auto-generated: contain numbers > 4 digits)
  if (el.id && !/\d{5,}/.test(el.id) && !el.id.includes(':')) {
    const candidate = `#${CSS.escape(el.id)}`;
    if (document.querySelectorAll(candidate).length === 1) return candidate;
  }

  // 4. Role + name combo
  const role = el.getAttribute('role');
  const name = el.getAttribute('name') || el.getAttribute('placeholder');
  if (role && name) {
    const candidate = `[role="${role}"][name="${CSS.escape(name)}"]`;
    if (document.querySelectorAll(candidate).length === 1) return candidate;
  }

  // 5. Stable class combo (skip dynamic classes with numbers)
  const stableClasses = Array.from(el.classList)
    .filter(c => !/\d{3,}/.test(c) && c.length < 40)
    .slice(0, 3);
  if (stableClasses.length > 0) {
    const tag = el.tagName.toLowerCase();
    const candidate = `${tag}.${stableClasses.join('.')}`;
    if (document.querySelectorAll(candidate).length === 1) return candidate;
  }

  // 6. Fallback: nth-child path (fragile — flagged in skill as low-confidence)
  return buildNthChildPath(el);
};

function buildNthChildPath(el) {
  const parts = [];
  let node = el;
  while (node && node !== document.body) {
    const tag = node.tagName.toLowerCase();
    const siblings = Array.from(node.parentNode?.children || []).filter(s => s.tagName === node.tagName);
    const idx = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    node = node.parentNode;
  }
  return parts.length > 0 ? parts.join(' > ') : null;
}
```

---

## 7. Capture Script (Demo Mode) — MAIN World

```javascript
// content/capture.js — injected into MAIN world

(function() {
  if (window.__captureActive) return; // idempotency guard
  window.__captureActive = true;

  let buffer = [];
  let flushTimer = null;
  const FLUSH_DELAY_MS = 400;

  // --- Event Capture ---
  const CAPTURE_EVENTS = ['click', 'input', 'change', 'keydown', 'focus', 'blur'];

  function eventHandler(event) {
    const el = event.target;
    if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') return;

    // Skip our own sidepanel events that leak into the page (shouldn't happen, but guard)
    if (el.closest?.('[data-universal-agent-ui]')) return;

    const record = {
      type: 'DOM_EVENT',
      eventType: event.type,
      tag: el.tagName.toLowerCase(),
      selector: window.__getStableSelector?.(el) || null,
      ariaLabel: el.getAttribute?.('aria-label') || null,
      role: el.getAttribute?.('role') || null,
      value: event.type === 'input' || event.type === 'change'
        ? (el.value ?? el.textContent?.slice(0, 200) ?? null)
        : null,
      innerText: el.innerText?.slice(0, 80) || null,
      timestamp: Date.now(),
      confidence: isNthChildSelector(window.__getStableSelector?.(el)) ? 'low' : 'high'
    };

    buffer.push(record);
    scheduleFlush();
  }

  CAPTURE_EVENTS.forEach(evt =>
    document.addEventListener(evt, eventHandler, { capture: true, passive: true })
  );

  // --- MutationObserver (structural changes only) ---
  const mutationObserver = new MutationObserver((mutations) => {
    // Filter to meaningful structural changes only — ignore attribute spam
    const meaningful = mutations.filter(m => {
      if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
        // Only record if visible nodes were added/removed
        const hasVisibleNodes = [...m.addedNodes, ...m.removedNodes].some(
          n => n.nodeType === 1 && n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE'
        );
        return hasVisibleNodes;
      }
      if (m.type === 'attributes') {
        // Only record attribute changes on interactive elements
        const el = m.target;
        return el.tagName && ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(el.tagName);
      }
      return false;
    });

    if (meaningful.length === 0) return;

    buffer.push({
      type: 'DOM_MUTATION',
      count: meaningful.length,
      summary: meaningful.slice(0, 3).map(m => ({
        kind: m.type,
        target: window.__getStableSelector?.(m.target) || m.target.tagName,
        added: m.addedNodes.length,
        removed: m.removedNodes.length
      })),
      timestamp: Date.now()
    });

    scheduleFlush();
  });

  mutationObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['value', 'aria-label', 'disabled', 'checked', 'selected'],
    characterData: false // too noisy
  });

  // --- Network Patch ---
  // Patch fetch BEFORE page scripts run (document_start timing via injection)
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const result = await origFetch.apply(this, args);
    try {
      const cloned = result.clone();
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      const method = args[1]?.method || 'GET';

      // Only record mutating calls — skip GETs that are just polling
      if (method !== 'GET' || isSignificantGetUrl(url)) {
        const bodyText = args[1]?.body
          ? (typeof args[1].body === 'string' ? args[1].body.slice(0, 500) : '[binary]')
          : null;

        buffer.push({
          type: 'NETWORK_FETCH',
          url: url?.split('?')[0], // strip query params for privacy
          method,
          body: bodyText,
          status: result.status,
          timestamp: Date.now()
        });
        scheduleFlush();
      }
    } catch (_) {} // never let patching break the page
    return result;
  };

  // XHR patch
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__ua_method = method;
    this.__ua_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    this.addEventListener('load', () => {
      if (this.__ua_method !== 'GET') {
        buffer.push({
          type: 'NETWORK_XHR',
          url: this.__ua_url?.split('?')[0],
          method: this.__ua_method,
          body: typeof body === 'string' ? body.slice(0, 500) : null,
          status: this.status,
          timestamp: Date.now()
        });
        scheduleFlush();
      }
    });
    return origSend.apply(this, arguments);
  };

  // --- Flush ---
  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  function flush() {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    window.postMessage({
      __universalAgent: true,
      type: 'ACTION_BATCH',
      events: batch,
      url: window.location.href,
      timestamp: Date.now()
    }, '*');
  }

  // --- Cleanup ---
  window.__stopCapture = function() {
    CAPTURE_EVENTS.forEach(evt =>
      document.removeEventListener(evt, eventHandler, { capture: true })
    );
    mutationObserver.disconnect();
    window.__captureActive = false;
    // Note: cannot unpatch fetch/XHR cleanly — they stay patched for session duration
  };

  function isNthChildSelector(sel) {
    return sel?.includes('nth-of-type') || sel?.includes('nth-child');
  }

  function isSignificantGetUrl(url) {
    // Capture GETs that look like they load document state
    return url && (url.includes('/slides/') || url.includes('/document/') || url.includes('/spreadsheet/'));
  }
})();
```

> **Bug risks:**
> - Fetch/XHR patching must happen before page scripts run. Since `capture.js` is injected programmatically, it may miss the very first fetches that fire at page load. For demo mode this is acceptable — the user is performing deliberate actions.
> - `result.clone()` on fetch responses is required because response bodies can only be consumed once. If you miss the `.clone()` call, calling `.json()` on the cloned response later will fail and you'll eat the original response silently.
> - Canvas-based UIs (Google Slides text editing, Figma): DOM events won't fire for canvas interactions. Your signal for these will be entirely from the network patch. Design the skill writer prompt to accept partial DOM evidence + network evidence.

---

## 8. Executor Script (Work Mode) — MAIN World

```javascript
// content/executor.js — injected into MAIN world

(function() {
  if (window.__executorActive) return;
  window.__executorActive = true;

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data?.__universalAgent) return;
    if (event.data.type !== 'EXECUTE_CODE') return;

    const { code, executionId } = event.data;
    let result = { executionId, success: false, error: null, output: null };

    try {
      // Execution sandbox: wrap in async IIFE, expose helpers
      const fn = new Function('__helpers', `
        const { click, setValue, waitForElement, getElement, delay } = __helpers;
        return (async () => {
          ${code}
        })();
      `);
      const output = await fn(executorHelpers);
      result = { executionId, success: true, output: output ?? null, error: null };
    } catch (err) {
      result = { executionId, success: false, error: err.message, output: null };
    }

    window.postMessage({
      __universalAgent: true,
      type: 'EXECUTION_RESULT',
      ...result
    }, '*');
  });

  // --- Execution Helpers ---
  const executorHelpers = {
    delay: (ms) => new Promise(r => setTimeout(r, ms)),

    waitForElement: (selector, timeoutMs = 5000) => {
      return new Promise((resolve, reject) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        const obs = new MutationObserver(() => {
          const found = document.querySelector(selector);
          if (found) { obs.disconnect(); resolve(found); }
        });
        obs.observe(document.body, { subtree: true, childList: true });
        setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeoutMs);
      });
    },

    getElement: (selector) => document.querySelector(selector),

    click: async (selectorOrEl) => {
      const el = typeof selectorOrEl === 'string'
        ? document.querySelector(selectorOrEl)
        : selectorOrEl;
      if (!el) throw new Error(`Element not found: ${selectorOrEl}`);
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return el;
    },

    setValue: (selectorOrEl, value) => {
      const el = typeof selectorOrEl === 'string'
        ? document.querySelector(selectorOrEl)
        : selectorOrEl;
      if (!el) throw new Error(`Element not found: ${selectorOrEl}`);

      el.focus();

      // React/Vue bypass: use native prototype setter to trigger synthetic event system
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el.constructor.prototype === HTMLTextAreaElement.prototype
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value'
      )?.set;

      if (nativeSetter) {
        nativeSetter.call(el, value);
      } else {
        el.value = value;
      }

      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el;
    }
  };
})();
```

> **Bug risks:**
> - `new Function(...)` is technically `eval`-like. MV3 extensions cannot use `eval` in extension pages (popup, service worker, sidepanel). However, it **is** permitted inside injected MAIN world scripts because that code runs in the page's context, not the extension's. This is the correct pattern.
> - The React native setter trick works for React 16+. React 18 changed some internals — if it fails silently, fall back to dispatching a synthetic `InputEvent` with `nativeEvent: true`.
> - `waitForElement` uses a MutationObserver with a timeout. If the selector never appears, the observer never disconnects until timeout. On heavy pages this can pile up. Always await `waitForElement` in generated code.

---

## 9. Service Worker — Orchestration Hub

The service worker is the brain. It keeps the LangGraph agent, manages mode state, and routes messages.

```javascript
// background/service-worker.js

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatMistralAI } from '@langchain/mistralai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MemorySaver } from '@langchain/langgraph';

// --- State ---
let appState = {
  mode: 'idle',        // 'idle' | 'demo' | 'work'
  activeTabId: null,
  sessionMemory: [],   // work mode: array of {task, actions, timestamp}
  pendingBatch: [],    // demo mode: buffered action batches awaiting voice segment
};

// Keep service worker alive during active session
// MV3 service workers die after ~30s idle — use a chrome.alarms keepalive
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { /* no-op: just wakes the SW */ });

// --- Message Routing ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'START_DEMO':
        await startDemoMode(message.tabId);
        sendResponse({ ok: true });
        break;
      case 'STOP_DEMO':
        await stopDemoMode();
        sendResponse({ ok: true });
        break;
      case 'START_WORK':
        await startWorkMode(message.tabId);
        sendResponse({ ok: true });
        break;
      case 'ACTION_BATCH':
        handleActionBatch(message, sender);
        break;
      case 'VOICE_SEGMENT':
        // Paired voice transcript chunk from sidepanel
        await handleVoiceSegment(message);
        sendResponse({ ok: true });
        break;
      case 'WORK_INSTRUCTION':
        // Single instruction from work mode (transcript complete)
        const result = await handleWorkInstruction(message.transcript, message.tabId);
        sendResponse(result);
        break;
      case 'EXECUTION_RESULT':
        // From executor via bridge
        handleExecutionResult(message);
        break;
    }
  })();
  return true; // async sendResponse
});

// --- Demo Mode ---
async function startDemoMode(tabId) {
  appState.mode = 'demo';
  appState.activeTabId = tabId;
  appState.pendingBatch = [];
  await injectMainWorldScripts(tabId);
  await chrome.tabs.sendMessage(tabId, { type: 'START_CAPTURE' });
}

function handleActionBatch(message) {
  if (appState.mode !== 'demo') return;
  appState.pendingBatch.push(...message.events);
}

async function handleVoiceSegment({ transcript, segmentEnd }) {
  if (appState.mode !== 'demo') return;
  
  // Grab all events that arrived during this voice segment
  const events = appState.pendingBatch.splice(0);
  if (events.length === 0) return;

  // Write skill via Mistral Large
  await writeSkillFromSegment(transcript, events);
}

// --- Work Mode ---
async function startWorkMode(tabId) {
  appState.mode = 'work';
  appState.activeTabId = tabId;
  appState.sessionMemory = [];
  await injectMainWorldScripts(tabId);
}

async function handleWorkInstruction(transcript, tabId) {
  const agent = buildWorkAgent(tabId);
  const result = await agent.invoke({
    messages: [{ role: 'user', content: transcript }]
  }, { configurable: { thread_id: `work-${tabId}-${Date.now()}` } });

  // Append to session memory
  appState.sessionMemory.push({
    timestamp: Date.now(),
    task: transcript,
    result: result.messages[result.messages.length - 1]?.content || ''
  });

  return { response: result.messages[result.messages.length - 1]?.content };
}
```

---

## 10. LangGraph Work Agent

```javascript
// background/work-agent.js

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatMistralAI } from '@langchain/mistralai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MemorySaver } from '@langchain/langgraph';

export function buildWorkAgent(tabId) {
  const llm = new ChatMistralAI({
    model: 'mistral-large-latest',
    apiKey: MISTRAL_API_KEY,
    temperature: 0.1
  });

  const executePageCodeTool = tool(
    async ({ code, description }) => {
      return new Promise((resolve) => {
        const executionId = crypto.randomUUID();

        // Register one-shot listener for result
        const listener = (message) => {
          if (message.type === 'EXECUTION_RESULT' && message.executionId === executionId) {
            chrome.runtime.onMessage.removeListener(listener);
            if (message.success) {
              resolve(`Success: ${message.output ?? 'action completed'}`);
            } else {
              resolve(`Error: ${message.error}`);
            }
          }
        };
        chrome.runtime.onMessage.addListener(listener);

        // Send to executor via bridge
        chrome.tabs.sendMessage(tabId, {
          type: 'EXECUTE_CODE',
          code,
          executionId
        });

        // Timeout guard
        setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve('Timeout: execution did not complete in 10s');
        }, 10000);
      });
    },
    {
      name: 'execute_page_code',
      description: 'Execute JavaScript in the active browser tab to interact with page elements. Use the helper functions: click(selector), setValue(selector, value), waitForElement(selector), delay(ms). Always await async operations.',
      schema: z.object({
        description: z.string().describe('Plain English description of what this code does'),
        code: z.string().describe('JavaScript code to execute. Must use only the provided helpers.')
      })
    }
  );

  const readSkillsTool = tool(
    async ({ query }) => {
      const skills = await loadAllSkills();
      if (skills.length === 0) return 'No skills recorded yet.';
      // Simple relevance filter: return skills whose name/description matches query words
      const queryWords = query.toLowerCase().split(/\s+/);
      const relevant = skills.filter(s =>
        queryWords.some(w => s.name.toLowerCase().includes(w) || s.description.toLowerCase().includes(w))
      );
      return relevant.length > 0
        ? relevant.map(s => `## ${s.name}\n${s.content}`).join('\n\n---\n\n')
        : `No relevant skills found for: ${query}. Available: ${skills.map(s => s.name).join(', ')}`;
    },
    {
      name: 'read_skills',
      description: 'Read recorded SKILL.md files to find how to perform tasks on websites.',
      schema: z.object({
        query: z.string().describe('What task or action you are looking for')
      })
    }
  );

  const readMemoryTool = tool(
    async () => {
      if (appState.sessionMemory.length === 0) return 'No previous tasks this session.';
      return appState.sessionMemory
        .map(m => `[${new Date(m.timestamp).toLocaleTimeString()}] Task: ${m.task}\nResult: ${m.result}`)
        .join('\n\n');
    },
    {
      name: 'read_session_memory',
      description: 'Read what tasks have been completed so far in this session.',
      schema: z.object({})
    }
  );

  const checkpointSaver = new MemorySaver();

  return createReactAgent({
    llm,
    tools: [executePageCodeTool, readSkillsTool, readMemoryTool],
    checkpointSaver,
    messageModifier: buildSystemPrompt()
  });
}

function buildSystemPrompt() {
  return `You are a browser automation agent running inside a Chrome extension.

Your job: execute the user's instruction by writing and running JavaScript in their active browser tab.

Workflow:
1. Read relevant skills with read_skills to find known action patterns for this website.
2. Write and execute targeted JavaScript using execute_page_code.
3. Verify the result. If it failed, try an alternative approach.
4. Report back in a single, concise sentence what you did.

Rules:
- Only use the provided helper functions: click(), setValue(), waitForElement(), delay(). Do not use document.querySelector directly in one-liners — use waitForElement for reliability.
- Never navigate away from the page unless explicitly asked.
- Never fill in credentials or submit payment forms.
- If a skill exists for the task, follow its action sequence exactly.
- Keep your final response to 1-2 sentences — it will be read aloud to the user.`;
}
```

---

## 11. Skill Writer (Demo Mode)

```javascript
// background/skill-writer.js

import Mistral from '@mistralai/mistralai';

const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });

export async function writeSkillFromSegment(transcript, events) {
  const eventSummary = formatEventsForPrompt(events);

  const response = await mistral.chat.complete({
    model: 'mistral-large-latest',
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: SKILL_WRITER_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: `Voice narration: "${transcript}"\n\nObserved events:\n${eventSummary}`
      }
    ]
  });

  const skillText = response.choices[0].message.content;

  // Parse skill name from the markdown
  const nameMatch = skillText.match(/^#\s+(.+)$/m);
  const skillName = nameMatch?.[1]?.trim() || `skill-${Date.now()}`;

  await saveSkill(skillName, skillText);
  return skillName;
}

const SKILL_WRITER_SYSTEM_PROMPT = `You write SKILL.md files for a browser automation agent.

Given a voice narration and a list of observed browser events, write a structured skill file.

Output ONLY the skill markdown. Format:

# [Concise skill name, e.g. "Add a new slide in Google Slides"]

## Description
[What this skill does, 1-2 sentences]

## Preconditions
- [State the page/app must be in]

## Actions
\`\`\`javascript
// Execution code using only these helpers:
// click(selector), setValue(selector, value), waitForElement(selector), delay(ms)
// All are async — always await them.

await click('[aria-label="New slide"]');
await waitForElement('.punch-viewer-container');
\`\`\`

## Network Signature (optional)
If the action triggers a specific network call, document it here for verification.
Method: POST
URL pattern: /presentations/*/slides

## Confidence
[high|medium|low] — based on selector quality and whether network evidence corroborates DOM events.

## Notes
[Any caveats — e.g. canvas-rendered UI, iframe context, React synthetic events]

Rules:
- Use aria-label selectors preferentially. They are the most stable.
- If a selector is marked low confidence (nth-child), note it and suggest the user re-record.
- If the voice narration is ambiguous, write the most conservative interpretation.
- Never include credentials, personal data, or full URL paths with document IDs.`;

function formatEventsForPrompt(events) {
  return events.map(e => {
    if (e.type === 'DOM_EVENT') {
      return `[${e.eventType}] ${e.tag} | selector: ${e.selector} | label: ${e.ariaLabel} | value: ${e.value} | confidence: ${e.confidence}`;
    }
    if (e.type === 'DOM_MUTATION') {
      return `[mutation] ${e.count} changes | ${e.summary.map(s => `${s.kind} on ${s.target}`).join(', ')}`;
    }
    if (e.type === 'NETWORK_FETCH' || e.type === 'NETWORK_XHR') {
      return `[network] ${e.method} ${e.url} → ${e.status}`;
    }
    return JSON.stringify(e);
  }).join('\n');
}

async function saveSkill(name, content) {
  const key = `skill_${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
  await chrome.storage.local.set({ [key]: { name, content, createdAt: Date.now() } });
}

async function loadAllSkills() {
  const all = await chrome.storage.local.get(null);
  return Object.values(all).filter(v => v?.name && v?.content);
}
```

---

## 12. Voxtral Realtime — Voice Transcription (Sidepanel)

Voxtral Realtime uses a WebSocket endpoint. The sidepanel connects directly.

```javascript
// sidepanel/panel.js — voice handling

const VOXTRAL_WS_URL = 'wss://api.mistral.ai/v1/realtime';  // verify against docs at build time
const MISTRAL_API_KEY = await getStoredApiKey();

let voxtralWs = null;
let mediaRecorder = null;
let audioStream = null;
let currentMode = 'idle';
let isListening = false;

// Demo mode: connect Voxtral Realtime, stream continuously
async function startDemoTranscription() {
  audioStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    }
  });

  voxtralWs = new WebSocket(`${VOXTRAL_WS_URL}?model=voxtral-mini-realtime`, [
    'Authorization', `Bearer ${MISTRAL_API_KEY}`
  ]);

  // Note: Mistral's WS auth may use a header rather than a subprotocol.
  // Verify exact auth mechanism in Mistral docs — browser WebSocket API cannot
  // set custom headers, so you may need to pass the key as a query param or
  // proxy through a lightweight local relay.
  // See: Bug Risk #1 below.

  voxtralWs.onopen = () => {
    voxtralWs.send(JSON.stringify({
      type: 'session.start',
      config: {
        language: 'en',
        transcription_delay_ms: 480   // 480ms = near-offline accuracy per Voxtral docs
      }
    }));
    startAudioStreaming();
  };

  voxtralWs.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'transcript.partial') {
      updateTranscriptDisplay(data.text, 'partial');
    }
    if (data.type === 'transcript.final') {
      updateTranscriptDisplay(data.text, 'final');
      // Send to service worker as a voice segment
      chrome.runtime.sendMessage({
        type: 'VOICE_SEGMENT',
        transcript: data.text,
        segmentEnd: Date.now()
      });
    }
  };

  voxtralWs.onclose = () => stopTranscription();
  voxtralWs.onerror = (e) => console.error('Voxtral WS error:', e);
}

function startAudioStreaming() {
  // Use AudioWorklet for low-latency PCM16 capture
  // Fallback: MediaRecorder with small timeslices
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(audioStream);

  // PCM16 via ScriptProcessorNode (deprecated but widely supported — use AudioWorklet in prod)
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!voxtralWs || voxtralWs.readyState !== WebSocket.OPEN) return;
    const float32 = e.inputBuffer.getChannelData(0);
    const pcm16 = convertFloat32ToPCM16(float32);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
    voxtralWs.send(JSON.stringify({ type: 'audio.append', audio: base64 }));
  };

  source.connect(processor);
  processor.connect(audioContext.destination);
}

function convertFloat32ToPCM16(float32Array) {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    pcm16[i] = Math.max(-32768, Math.min(32767, float32Array[i] * 32768));
  }
  return pcm16;
}

// Work mode: push-to-talk style — mic on, get transcript, mic off
async function captureWorkInstruction() {
  isListening = true;
  updateMicUI(true);

  // Simple approach for work mode: record a segment, then batch-transcribe via Voxtral
  // This avoids WS connection overhead for the short burst of work instructions
  const chunks = [];
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);

  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.start();

  // Listen for mic toggle off (button press) or silence
  return new Promise((resolve) => {
    window.__stopListening = () => {
      recorder.stop();
      stream.getTracks().forEach(t => t.stop());
    };
    recorder.onstop = async () => {
      isListening = false;
      updateMicUI(false);
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const transcript = await transcribeWithVoxtral(blob);
      resolve(transcript);
    };
  });
}

async function transcribeWithVoxtral(audioBlob) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');
  formData.append('model', 'voxtral-mini-transcribe-v2'); // batch endpoint

  const response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MISTRAL_API_KEY}` },
    body: formData
  });
  const data = await response.json();
  return data.text;
}
```

> **Bug Risk #1 — WebSocket auth in the browser:** The browser's native WebSocket API does not support setting custom HTTP headers. Mistral's API key cannot be passed as a `Authorization` header from a browser WS connection. Mitigation options:
> 1. Pass key as a query parameter: `wss://api.mistral.ai/v1/realtime?api_key=xxx` — check if Mistral supports this.
> 2. Run a lightweight local relay in a Node.js sidecar that the extension connects to, which forwards to Mistral with the proper header.
> 3. For the hackathon: use the batch transcription endpoint for demo mode too (slightly higher latency but simpler), and only use Realtime if Mistral exposes a query-param auth option.

---

## 13. ElevenLabs TTS + Loop Termination

```javascript
// sidepanel/panel.js — work mode loop

const ELEVENLABS_API_KEY = await getStoredApiKey('elevenlabs');
const VOICE_ID = 'your-chosen-voice-id';

async function speakResponse(text) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',  // lowest latency model
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });

  const audioBlob = await response.blob();
  const audioUrl = URL.createObjectURL(audioBlob);
  const audio = new Audio(audioUrl);

  return new Promise((resolve) => {
    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      resolve(); // ← loop termination point
    };
    audio.onerror = () => resolve(); // don't block on TTS failure
    audio.play();
  });
}

// Work mode loop
async function runWorkInstruction() {
  if (currentMode !== 'work') return;

  // 1. Capture instruction
  const transcript = await captureWorkInstruction();
  if (!transcript.trim()) return;

  showStatus('Thinking...');

  // 2. Agent processes + executes
  const { response } = await chrome.runtime.sendMessage({
    type: 'WORK_INSTRUCTION',
    transcript,
    tabId: appState.activeTabId
  });

  // 3. Speak response
  showStatus('Speaking...');
  await speakResponse(response);

  // 4. Loop ends here — mic is NOT automatically re-enabled
  // User must press mic button again for next instruction
  showStatus('Ready');

  // This prevents context accumulation and racing:
  // Each instruction is a clean LangGraph invocation with its own thread_id
}
```

> **Why no auto-loop:** Auto-looping creates races between ElevenLabs playback finishing and the mic re-enabling. It also causes the "agent hears itself" problem where TTS output gets picked up by the mic. The explicit press-to-talk model avoids all of this cleanly for a hackathon. If you want auto-resumption later, add a 500ms delay + energy threshold gate.

---

## 14. Session Memory (`memory.md`)

Each work mode session maintains an in-memory log. It's never persisted — it's destroyed when the sidepanel is closed or `STOP_WORK` is sent.

```javascript
// Format of each sessionMemory entry:
{
  timestamp: 1709123456789,
  task: "Add a new slide after slide 3",
  actionsExecuted: [
    "click('[aria-label=\"New slide\"]')",
    "// Used skill: Add a new slide in Google Slides"
  ],
  result: "Added a new slide after slide 3."
}

// memory.md format (generated on demand for prompt injection):
function generateMemoryMd(sessionMemory) {
  return `# Session Memory\n\n` + sessionMemory.map(m =>
    `## [${new Date(m.timestamp).toLocaleTimeString()}] ${m.task}\n${m.result}`
  ).join('\n\n');
}
```

The memory is injected into each LangGraph invocation's system context via the `read_session_memory` tool, not appended to the message thread — this keeps the LLM context clean and prevents message accumulation.

---

## 15. Edge Cases and Known Bug Surfaces

### Service Worker Lifecycle
MV3 service workers are terminated after ~30 seconds of inactivity. The `chrome.alarms` keepalive pattern (alarm every 0.4 minutes) is the accepted community workaround. However: if the SW dies mid-execution, all in-flight LangGraph runs die silently. Mitigation: acknowledge to the sidepanel immediately on message receipt, and use a heartbeat ping from the sidepanel every 15 seconds while a session is active to keep the SW alive.

### Navigation During Session
If the user navigates to a new page while demo or work mode is active, injected scripts are destroyed. Listen to `chrome.tabs.onUpdated` with `changeInfo.status === 'complete'` and re-inject. Restore `__captureActive` and `__executorActive` guard flags.

### Cross-Origin Iframes
`all_frames: true` on bridge.js injects into same-origin iframes only. Cross-origin iframes (e.g. Google Slides embeds certain panels in iframes from different origins) are sandboxed by the browser. You cannot capture their events. This affects a subset of Google Docs/Slides actions. Mitigation: rely on the network patch at the top-level frame — API calls from within iframes still bubble up through the main frame's fetch.

### Content Security Policy (CSP)
Some sites (e.g. Gmail, Notion) have strict CSPs that block `new Function(...)` or inline scripts. Since executor.js is a registered extension resource injected via `chrome.scripting`, it is exempt from the page's CSP. The `new Function()` call inside an injected MAIN world script is permitted. Verify this doesn't trip the site's CSP by testing early.

### React 18 + Concurrent Mode
`setValue` with the native prototype setter trick works in React 16/17. React 18 Concurrent Mode can batch state updates differently. If `setValue` triggers no re-render, fall back to programmatically dispatching an `InputEvent` with `{bubbles: true, composed: true}`. You can also try `ReactDOM.flushSync` if you have access to the React internal, but this is not guaranteed.

### Voxtral Realtime API Availability
As of February 2026, Voxtral Realtime is newly released. The exact WebSocket endpoint URL, message format, and browser auth mechanism may differ from what's documented in the initial release. Plan to verify against `https://docs.mistral.ai/capabilities/audio_transcription` at build time and keep the transcription layer swappable (the batch endpoint is a stable fallback).

### LangGraph in a Service Worker
`@langchain/langgraph` is designed for Node.js and browser environments, but service workers have no `window`, no `localStorage`, and restricted async timing. `MemorySaver` (in-memory checkpointer) works fine. Avoid any LangGraph features that use IndexedDB or `localStorage` for persistence — use `chrome.storage.local` instead.

### Selector Degradation
When a skill is recorded on one version of Google Slides and replayed after an update, aria-labels may change. Build in a fallback: if the primary selector fails in `waitForElement`, have the agent prompt the user with "I couldn't find [element]. Should I re-record this skill?"

---

## 16. Build Setup

```bash
# Install dependencies
npm install @langchain/langgraph @langchain/mistralai @langchain/core zod

# Bundle the service worker and sidepanel (webpack or esbuild)
# esbuild recommended: faster, handles ESM in service workers correctly

esbuild background/service-worker.js \
  --bundle \
  --format=esm \
  --outfile=dist/background/service-worker.js \
  --external:chrome

esbuild sidepanel/panel.js \
  --bundle \
  --format=iife \
  --outfile=dist/sidepanel/panel.js

# content scripts do NOT get bundled — they're injected as standalone files
cp content/capture.js dist/content/
cp content/executor.js dist/content/
cp content/bridge.js dist/content/
cp lib/selector.js dist/lib/
```

> **Critical:** Content scripts injected via `chrome.scripting.executeScript` with `files:` must be listed in `web_accessible_resources` and must NOT be ES modules (no `import`/`export`). Keep them as plain IIFE scripts.

---

## 17. Day-by-Day Hackathon Build Order

**Day 1 (8hrs):**
1. Manifest + bridge.js + selector.js — test that bridge relays messages correctly (2hr)
2. capture.js in isolation — verify click/input/network events are logged to console (2hr)
3. executor.js — test click(), setValue(), waitForElement() manually via console injection (2hr)
4. Service worker skeleton + mode state + message routing (1hr)
5. Sidepanel basic UI: mode toggle, log display (1hr)

**Day 2 (8hrs):**
1. Voxtral batch transcription working end-to-end from sidepanel (1.5hr)
2. Demo mode: capture + transcription → Mistral Large → skill written to chrome.storage (2.5hr)
3. LangGraph work agent with execute_page_code tool — test with hardcoded instruction (2hr)
4. ElevenLabs TTS + loop termination (1hr)
5. Memory.md injection into agent (1hr)

**Day 3 (Demo prep 4hrs):**
1. Polish demo flow on Google Slides specifically (2hr)
2. Error handling + graceful fallbacks (1hr)
3. Demo script + recording (1hr)

---

## 18. API Keys Storage

Store all API keys in `chrome.storage.local` (not `sync` — sync has strict size limits). Set them once via a simple options page or hardcode for hackathon:

```javascript
// Setup (once)
await chrome.storage.local.set({
  mistral_api_key: 'your-key',
  elevenlabs_api_key: 'your-key'
});

// Read
async function getStoredApiKey(service = 'mistral') {
  const key = service === 'mistral' ? 'mistral_api_key' : 'elevenlabs_api_key';
  const result = await chrome.storage.local.get(key);
  return result[key];
}
```

> Never hardcode API keys in files that get committed to source control or bundled into `web_accessible_resources`, as these are readable by any page that knows the extension ID.