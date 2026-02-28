import { writeSkillFromSegment, loadAllSkills, deleteSkill } from './skill-writer.js';
import { buildWorkAgent } from './work-agent.js';

const MODE_IDLE = 'idle';
const MODE_DEMO = 'demo';
const MODE_WORK = 'work';
const FRAME_SWEEP_DELAYS_MS = [1200, 3500, 8000];

const appState = {
  mode: MODE_IDLE,
  activeTabId: null,
  sessionMemory: [],
  pendingBatch: [],
  demoStartedAt: 0,
  demoSegments: [],
  demoPageScaffold: null,
  captureDiagnostics: {
    batchesReceived: 0,
    actionsReceived: 0,
    ignoredBatches: 0,
    byAction: {},
    lastStatusAt: 0
  }
};

const pendingExecutions = new Map();

function resetCaptureDiagnostics() {
  appState.captureDiagnostics = {
    batchesReceived: 0,
    actionsReceived: 0,
    ignoredBatches: 0,
    byAction: {},
    lastStatusAt: 0
  };
}

function formatActionBreakdown(counts) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    return 'none';
  }
  return entries.map(([key, value]) => `${key}:${value}`).join(', ');
}

function truncateForLog(value, max = 80) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function formatRelativeTime(ms) {
  const value = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return `${(value / 1000).toFixed(2)}s`;
}

function previewMultiline(text, maxLines = 14, maxChars = 1800) {
  const safeText = String(text || '');
  if (!safeText.trim()) {
    return '';
  }
  const lines = safeText.split('\n').slice(0, maxLines);
  let preview = lines.join('\n');
  if (safeText.length > maxChars) {
    preview = preview.slice(0, maxChars - 1) + '…';
  }
  if (safeText.split('\n').length > maxLines) {
    preview += '\n…';
  }
  return preview;
}

function buildPageMapCode({ mode, targetSelector, depth, maxNodes }) {
  const safeMode = mode === 'zoom' ? 'zoom' : 'summary';
  const safeDepth = Number.isFinite(depth) ? Math.max(1, Math.min(7, depth)) : 4;
  const safeMaxNodes = Number.isFinite(maxNodes) ? Math.max(20, Math.min(500, maxNodes)) : 180;

  return `
    const __uaMode = ${JSON.stringify(safeMode)};
    const __uaTargetSelector = ${JSON.stringify(targetSelector || '')};
    const __uaDepth = ${safeDepth};
    const __uaMaxNodes = ${safeMaxNodes};

    function __uaText(value, maxLen = 80) {
      const text = String(value || '').replace(/\\s+/g, ' ').trim();
      return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
    }

    function __uaSelector(el) {
      try {
        if (window.__getStableSelector) {
          return window.__getStableSelector(el);
        }
      } catch (_err) {}
      return null;
    }

    function __uaInteractive(el) {
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toUpperCase();
      if (['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'].includes(tag)) return true;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (['button', 'link', 'textbox', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'combobox'].includes(role)) return true;
      if (el.hasAttribute('contenteditable')) return true;
      const tabIndex = el.getAttribute('tabindex');
      return tabIndex !== null && tabIndex !== '-1';
    }

    function __uaNodeInfo(el, depthValue, path) {
      const role = el.getAttribute('role') || null;
      const label = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || null;
      return {
        tag: el.tagName ? el.tagName.toLowerCase() : 'unknown',
        role,
        selector: __uaSelector(el),
        text: __uaText(el.innerText || el.textContent || '', 100),
        label: __uaText(label || '', 80),
        depth: depthValue,
        path,
        interactive: __uaInteractive(el)
      };
    }

    function __uaCollect(root, maxDepth, maxNodes) {
      const nodes = [];
      const queue = [{ el: root, depth: 0, path: '0' }];
      while (queue.length && nodes.length < maxNodes) {
        const current = queue.shift();
        const el = current.el;
        if (!el || !el.tagName) continue;
        nodes.push(__uaNodeInfo(el, current.depth, current.path));
        if (current.depth >= maxDepth) continue;
        const children = Array.from(el.children || []);
        for (let i = 0; i < children.length; i += 1) {
          queue.push({ el: children[i], depth: current.depth + 1, path: current.path + '.' + i });
          if (queue.length + nodes.length >= maxNodes * 2) break;
        }
      }
      const interactive = nodes.filter((n) => n.interactive).slice(0, Math.floor(maxNodes * 0.6));
      const landmarks = nodes.filter((n) => ['main', 'nav', 'section', 'form', 'table', 'header', 'footer', 'aside'].includes(n.tag) || n.role === 'dialog').slice(0, 80);
      return { nodes, interactive, landmarks };
    }

    const __uaTopRoot = document.documentElement || document.body;
    let __uaTarget = null;
    if (__uaMode === 'zoom' && __uaTargetSelector) {
      try { __uaTarget = document.querySelector(__uaTargetSelector); } catch (_err) { __uaTarget = null; }
    }
    const __uaBase = __uaTarget || __uaTopRoot;
    const collect = __uaCollect(__uaBase, __uaDepth, __uaMaxNodes);

    return {
      mode: __uaMode,
      url: window.location.href,
      title: __uaText(document.title || '', 140),
      focusedSelector: __uaSelector(document.activeElement),
      targetSelector: __uaTargetSelector || null,
      targetFound: !!__uaTarget,
      totalNodes: collect.nodes.length,
      landmarks: collect.landmarks,
      interactive: collect.interactive
    };
  `;
}

async function captureDemoPageContext(tabId) {
  if (typeof tabId !== 'number') {
    return null;
  }

  try {
    const summaryResult = await executePageCodeInTab({
      tabId,
      code: buildPageMapCode({ mode: 'summary', depth: 4, maxNodes: 220 })
    });
    if (!summaryResult?.success) {
      return null;
    }

    return {
      summary: summaryResult.output || null,
      zooms: []
    };
  } catch (err) {
    console.warn('[sw] captureDemoPageContext failed', err);
    return null;
  }
}

async function sendCaptureDiagStatus(message, level = 'info') {
  await safeSendRuntimeMessage({
    type: 'STATUS_UPDATE',
    level,
    message: `[capture-diag] ${message}`
  });
}

function formatActionDetail(actionRecord) {
  const action = actionRecord?.action || 'unknown';
  switch (action) {
    case 'click':
      return `click selector="${truncateForLog(actionRecord?.selector || 'null', 120)}" tag="${truncateForLog(actionRecord?.tag || '', 40)}" label="${truncateForLog(actionRecord?.ariaLabel || '', 80)}" text="${truncateForLog(actionRecord?.innerText || '', 80)}"`;
    case 'fill':
      return `fill selector="${truncateForLog(actionRecord?.selector || 'null', 120)}" label="${truncateForLog(actionRecord?.ariaLabel || '', 80)}" value="${truncateForLog(actionRecord?.value || '', 120)}"`;
    case 'selectOptions':
      return `selectOptions selector="${truncateForLog(actionRecord?.selector || 'null', 120)}" value="${truncateForLog(actionRecord?.value || '', 100)}"`;
    case 'keyboard':
      return `keyboard type="${truncateForLog(actionRecord?.eventType || 'keydown', 40)}" key="${truncateForLog(actionRecord?.key || '', 40)}" code="${truncateForLog(actionRecord?.code || '', 40)}" ctrl=${!!actionRecord?.ctrlKey} meta=${!!actionRecord?.metaKey} alt=${!!actionRecord?.altKey} shift=${!!actionRecord?.shiftKey} selector="${truncateForLog(actionRecord?.selector || 'null', 120)}"`;
    case 'network':
      return `network method="${truncateForLog(actionRecord?.method || '', 10)}" url="${truncateForLog(actionRecord?.url || '', 160)}" status="${truncateForLog(actionRecord?.status || '', 10)}"`;
    default:
      return `unknown payload="${truncateForLog(JSON.stringify(actionRecord), 180)}"`;
  }
}

function maybeSendCaptureDiagStatus(message, level = 'info', force = false) {
  const now = Date.now();
  const sinceLast = now - (appState.captureDiagnostics.lastStatusAt || 0);
  if (!force && sinceLast < 1200) {
    return;
  }
  appState.captureDiagnostics.lastStatusAt = now;
  sendCaptureDiagStatus(message, level).catch(() => {});
}

async function injectAllFramesSweep(tabId, reason) {
  try {
    await getInjectableTab(tabId);
    const prefix = getScriptPrefix();
    const files = [`${prefix}lib/selector.js`, `${prefix}content/capture.js`, `${prefix}content/executor.js`];

    for (const file of files) {
      await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: [file],
          world: 'MAIN'
        }),
        3500,
        `${reason} ${file} allFrames sweep`
      );
    }
    maybeSendCaptureDiagStatus(`frame sweep success (${reason}) on tab=${tabId}`, 'info');
  } catch (err) {
    maybeSendCaptureDiagStatus(
      `frame sweep partial/failed (${reason}) on tab=${tabId}: ${err && err.message ? err.message : String(err)}`,
      'info'
    );
  }
}

function scheduleFrameCoverageSweeps(tabId, mode) {
  for (let i = 0; i < FRAME_SWEEP_DELAYS_MS.length; i += 1) {
    const delayMs = FRAME_SWEEP_DELAYS_MS[i];
    setTimeout(() => {
      if (appState.mode !== mode) {
        return;
      }
      if (appState.activeTabId !== tabId) {
        return;
      }
      injectAllFramesSweep(tabId, `${mode}#${i + 1}`).catch(() => {});
    }, delayMs);
  }
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

async function executeScriptBestEffort(tabId, file, world) {
  const allFramesLabel = `${file} allFrames injection`;
  const topFrameLabel = `${file} topFrame injection`;

  try {
    await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: [file],
        world
      }),
      3500,
      allFramesLabel
    );
    return { scope: 'allFrames' };
  } catch (allFramesErr) {
    console.warn('[sw] allFrames injection failed, falling back to top frame', {
      tabId,
      file,
      error: allFramesErr?.message || String(allFramesErr)
    });
  }

  await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      files: [file],
      world
    }),
    3500,
    topFrameLabel
  );
  return { scope: 'topFrame' };
}

async function enableActionClickToOpenSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error('[sw] setPanelBehavior failed', err);
  }
}

function getScriptPrefix() {
  try {
    const swPath = chrome.runtime.getManifest()?.background?.service_worker || '';
    return swPath.startsWith('dist/') ? 'dist/' : '';
  } catch (_err) {
    return '';
  }
}

async function safeSendRuntimeMessage(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (err) {
    console.error('[sw] safeSendRuntimeMessage failed', err);
  }
}

async function safeSendTabMessage(tabId, message) {
  try {
    if (typeof tabId !== 'number') {
      return;
    }
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    console.error('[sw] safeSendTabMessage failed', { tabId, messageType: message?.type, err });
  }
}

async function getInjectableTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    throw new Error('Cannot inject into this tab');
  }
  return tab;
}

export async function injectMainWorldScripts(tabId) {
  try {
    await getInjectableTab(tabId);
    const prefix = getScriptPrefix();
    const files = [`${prefix}lib/selector.js`, `${prefix}content/capture.js`, `${prefix}content/executor.js`];

    for (const file of files) {
      const result = await executeScriptBestEffort(tabId, file, 'MAIN');
      console.log('[sw] injected main-world script', { tabId, file, scope: result.scope });
    }
  } catch (err) {
    console.error('[sw] injectMainWorldScripts failed', { tabId, err });
    throw err;
  }
}

async function startDemoMode(tabId) {
  try {
    resetCaptureDiagnostics();
    appState.mode = MODE_DEMO;
    appState.activeTabId = tabId;
    appState.pendingBatch = [];
    appState.demoStartedAt = Date.now();
    appState.demoSegments = [];
    appState.demoPageScaffold = null;
    await withTimeout(injectMainWorldScripts(tabId), 25000, 'Demo injection');
    appState.demoPageScaffold = await captureDemoPageContext(tabId);
    scheduleFrameCoverageSweeps(tabId, MODE_DEMO);
    await safeSendRuntimeMessage({ type: 'STATUS_UPDATE', level: 'info', message: 'Demo mode started.' });
    maybeSendCaptureDiagStatus(`capture pipeline armed for tab=${tabId}; waiting for ACTION_BATCH...`, 'info', true);
    if (appState.demoPageScaffold?.summary) {
      maybeSendCaptureDiagStatus(
        `captured demo scaffold title="${truncateForLog(appState.demoPageScaffold.summary.title || '', 80)}" nodes=${appState.demoPageScaffold.summary.totalNodes || 0}`,
        'info',
        true
      );
    }
  } catch (err) {
    console.error('[sw] startDemoMode failed', err);
    appState.mode = MODE_IDLE;
    appState.activeTabId = null;
    throw err;
  }
}

async function stopDemoMode() {
  try {
    const tabId = appState.activeTabId;
    await safeSendTabMessage(tabId, { type: 'STOP_CAPTURE' });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const demoSegments = appState.demoSegments.slice();
    const trailingEvents = appState.pendingBatch.slice();

    if (demoSegments.length || trailingEvents.length) {
      if (trailingEvents.length) {
        if (demoSegments.length) {
          const last = demoSegments[demoSegments.length - 1];
          last.events = (last.events || []).concat(trailingEvents);
        } else {
          demoSegments.push({
            transcript: '[No transcript captured]',
            segmentStart: 0,
            segmentEnd: trailingEvents[trailingEvents.length - 1]?.timestamp || 0,
            events: trailingEvents
          });
        }
      }

      const finalTranscript = demoSegments
        .map((segment) => String(segment.transcript || '').trim())
        .filter(Boolean)
        .join('\n');
      const transcriptTimeline = demoSegments
        .map((segment) => {
          const text = String(segment.transcript || '').trim();
          if (!text) {
            return null;
          }
          const ts =
            typeof segment.segmentEnd === 'number' && Number.isFinite(segment.segmentEnd)
              ? segment.segmentEnd
              : typeof segment.segmentStart === 'number' && Number.isFinite(segment.segmentStart)
                ? segment.segmentStart
                : 0;
          return `[${formatRelativeTime(ts)}] ${text}`;
        })
        .filter(Boolean)
        .join('\n');
      const finalEvents = demoSegments.flatMap((segment) => (Array.isArray(segment.events) ? segment.events : []));
      const pageContext = appState.demoPageScaffold || null;

      if (finalTranscript && finalEvents.length) {
        await safeSendRuntimeMessage({
          type: 'STATUS_UPDATE',
          level: 'info',
          message: 'Generating skill from recorded demo...'
        });
        const skillResult = await writeSkillFromSegment(finalTranscript, finalEvents, {
          transcriptTimeline,
          pageContext
        });
        const skillName = typeof skillResult === 'string' ? skillResult : skillResult?.skillName || `skill-${Date.now()}`;
        const skillContent = typeof skillResult === 'string' ? '' : skillResult?.skillText || '';
        const promptInput = typeof skillResult === 'string' ? null : skillResult?.promptInput || null;
        await safeSendRuntimeMessage({
          type: 'STATUS_UPDATE',
          level: 'success',
          message: `Saved skill: ${skillName}`
        });
        await safeSendRuntimeMessage({
          type: 'DEMO_SKILL_RESULT',
          skillName,
          skillContent,
          debug: {
            transcriptTimelinePreview: previewMultiline(transcriptTimeline, 14, 1800),
            actionsPreview: previewMultiline(promptInput?.observedActions || '', 18, 2600),
            pageContextPreview: previewMultiline(promptInput?.pageContext || '', 18, 2600),
            transcriptPreview: previewMultiline(finalTranscript, 8, 1000),
            actionCount: finalEvents.length,
            segmentCount: demoSegments.length
          }
        });
      } else {
        await safeSendRuntimeMessage({
          type: 'STATUS_UPDATE',
          level: 'info',
          message: 'Demo stopped with no complete transcript+event payload to process.'
        });
      }
    }

    appState.mode = MODE_IDLE;
    appState.activeTabId = null;
    appState.pendingBatch = [];
    appState.demoStartedAt = 0;
    appState.demoSegments = [];
    appState.demoPageScaffold = null;
    maybeSendCaptureDiagStatus(
      `summary batches=${appState.captureDiagnostics.batchesReceived} actions=${appState.captureDiagnostics.actionsReceived} ignored=${appState.captureDiagnostics.ignoredBatches} byAction=${formatActionBreakdown(appState.captureDiagnostics.byAction)}`,
      'info',
      true
    );
    await safeSendRuntimeMessage({ type: 'STATUS_UPDATE', level: 'info', message: 'Demo mode stopped.' });
  } catch (err) {
    console.error('[sw] stopDemoMode failed', err);
    throw err;
  }
}

function handleActionBatch(message, sender) {
  try {
    if (appState.mode !== MODE_DEMO) {
      appState.captureDiagnostics.ignoredBatches += 1;
      if (appState.captureDiagnostics.ignoredBatches <= 3 || appState.captureDiagnostics.ignoredBatches % 10 === 0) {
        maybeSendCaptureDiagStatus(
          `ignored ACTION_BATCH while mode=${appState.mode}; tab=${sender?.tab?.id ?? 'n/a'} frame=${sender?.frameId ?? 'n/a'}`,
          'info',
          true
        );
      }
      return;
    }
    if (!Array.isArray(message.actions)) {
      appState.captureDiagnostics.ignoredBatches += 1;
      maybeSendCaptureDiagStatus(
        `received ACTION_BATCH without actions[] payload; keys=${Object.keys(message || {}).join(', ') || 'none'}`,
        'error',
        true
      );
      return;
    }
    const demoStartedAt = appState.demoStartedAt || Date.now();
    const fallbackTimestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now();
    const normalizedEvents = message.actions.map((event) => {
      const sourceTimestamp = typeof event?.timestamp === 'number' ? event.timestamp : fallbackTimestamp;
      const relativeTimestamp = Math.max(0, sourceTimestamp - demoStartedAt);
      if (event && typeof event === 'object' && typeof event.timestamp !== 'number') {
        return {
          ...event,
          timestamp: relativeTimestamp
        };
      }
      if (event && typeof event === 'object') {
        return {
          ...event,
          timestamp: relativeTimestamp
        };
      }
      return event;
    });
    appState.pendingBatch.push(...normalizedEvents);

    const byActionInBatch = {};
    for (const actionRecord of normalizedEvents) {
      const actionType = actionRecord?.action || 'unknown';
      byActionInBatch[actionType] = (byActionInBatch[actionType] || 0) + 1;
      appState.captureDiagnostics.byAction[actionType] = (appState.captureDiagnostics.byAction[actionType] || 0) + 1;
    }

    appState.captureDiagnostics.batchesReceived += 1;
    appState.captureDiagnostics.actionsReceived += normalizedEvents.length;

    const shouldReport =
      appState.captureDiagnostics.batchesReceived <= 3 || appState.captureDiagnostics.batchesReceived % 5 === 0;
    if (shouldReport) {
      maybeSendCaptureDiagStatus(
        `batch#${appState.captureDiagnostics.batchesReceived} actions=${normalizedEvents.length} totalActions=${appState.captureDiagnostics.actionsReceived} inBatch=${formatActionBreakdown(byActionInBatch)} totalByAction=${formatActionBreakdown(appState.captureDiagnostics.byAction)} tab=${sender?.tab?.id ?? 'n/a'} frame=${sender?.frameId ?? 'n/a'} pending=${appState.pendingBatch.length}`,
        'info'
      );
    }

    const senderTab = sender?.tab?.id ?? 'n/a';
    const senderFrame = sender?.frameId ?? 'n/a';
    for (const actionRecord of normalizedEvents) {
      const at = formatRelativeTime(actionRecord?.timestamp);
      const detail = formatActionDetail(actionRecord);
      sendCaptureDiagStatus(`action@${at} ${detail} tab=${senderTab} frame=${senderFrame}`).catch(() => {});
    }
  } catch (err) {
    console.error('[sw] handleActionBatch failed', err);
    maybeSendCaptureDiagStatus(`handleActionBatch error: ${err && err.message ? err.message : String(err)}`, 'error', true);
  }
}

async function handleVoiceSegment(message) {
  try {
    if (appState.mode !== MODE_DEMO) {
      return { ok: false, skipped: true, reason: 'Not in demo mode.' };
    }

    const transcript = String(message.transcript || '').trim();
    if (!transcript) {
      return { ok: false, skipped: true, reason: 'Empty transcript.' };
    }

    const segmentEndAbsolute =
      typeof message.segmentEnd === 'number' && Number.isFinite(message.segmentEnd) ? message.segmentEnd : null;
    const segmentEnd =
      segmentEndAbsolute === null
        ? null
        : Math.max(0, segmentEndAbsolute - (appState.demoStartedAt || segmentEndAbsolute));

    let events = [];
    if (segmentEnd === null) {
      events = appState.pendingBatch.splice(0, appState.pendingBatch.length);
    } else {
      const toProcess = [];
      const keepForNextSegment = [];
      for (const event of appState.pendingBatch) {
        const ts = typeof event?.timestamp === 'number' ? event.timestamp : 0;
        if (ts > 0 && ts <= segmentEnd) {
          toProcess.push(event);
        } else if (ts === 0) {
          toProcess.push({
            ...event,
            timestamp: segmentEnd
          });
        } else {
          keepForNextSegment.push(event);
        }
      }
      appState.pendingBatch = keepForNextSegment;
      events = toProcess;
    }

    appState.demoSegments.push({
      transcript,
      segmentStart: typeof message.segmentStart === 'number' ? message.segmentStart : null,
      segmentEnd: segmentEnd,
      events
    });

    return {
      ok: true,
      buffered: true,
      segmentCount: appState.demoSegments.length,
      eventCount: events.length
    };
  } catch (err) {
    console.error('[sw] handleVoiceSegment failed', err);
    await safeSendRuntimeMessage({
      type: 'STATUS_UPDATE',
      level: 'error',
      message: err && err.message ? err.message : String(err)
    });
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function startWorkMode(tabId) {
  try {
    appState.mode = MODE_WORK;
    appState.activeTabId = tabId;
    appState.sessionMemory = [];
    await withTimeout(injectMainWorldScripts(tabId), 25000, 'Work injection');
    scheduleFrameCoverageSweeps(tabId, MODE_WORK);
    await safeSendRuntimeMessage({ type: 'STATUS_UPDATE', level: 'info', message: 'Work mode started.' });
  } catch (err) {
    console.error('[sw] startWorkMode failed', err);
    appState.mode = MODE_IDLE;
    appState.activeTabId = null;
    throw err;
  }
}

async function stopWorkMode() {
  try {
    appState.mode = MODE_IDLE;
    appState.sessionMemory = [];
    appState.activeTabId = null;
    await safeSendRuntimeMessage({ type: 'STATUS_UPDATE', level: 'info', message: 'Work mode stopped.' });
  } catch (err) {
    console.error('[sw] stopWorkMode failed', err);
    throw err;
  }
}

async function executePageCodeInTab({ tabId, code }) {
  const executionId = crypto.randomUUID();

  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => {
      pendingExecutions.delete(executionId);
      resolve({ success: false, error: 'Timeout: execution did not complete in 10s', output: null });
    }, 10000);

    pendingExecutions.set(executionId, { resolve, timeout });

    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'EXECUTE_CODE',
        code,
        executionId
      });
    } catch (err) {
      clearTimeout(timeout);
      pendingExecutions.delete(executionId);
      resolve({
        success: false,
        error: err && err.message ? err.message : String(err),
        output: null
      });
    }
  });
}

function handleExecutionResult(message) {
  try {
    const executionId = message.executionId;
    if (!executionId || !pendingExecutions.has(executionId)) {
      return;
    }

    const pending = pendingExecutions.get(executionId);
    clearTimeout(pending.timeout);
    pendingExecutions.delete(executionId);

    pending.resolve({
      success: !!message.success,
      error: message.error || null,
      output: message.output ?? null
    });
  } catch (err) {
    console.error('[sw] handleExecutionResult failed', err);
  }
}

async function handleWorkInstruction(transcript, tabId) {
  try {
    if (appState.mode !== MODE_WORK) {
      throw new Error('Work mode is not active.');
    }
    const targetTabId = typeof tabId === 'number' ? tabId : appState.activeTabId;
    if (typeof targetTabId !== 'number') {
      throw new Error('No active tab for work mode.');
    }

    const agent = await buildWorkAgent({
      tabId: targetTabId,
      executePageCode: executePageCodeInTab,
      loadAllSkills,
      getSessionMemory: function () {
        return appState.sessionMemory.slice();
      }
    });

    const result = await agent.invoke(
      { messages: [{ role: 'user', content: transcript }] },
      { configurable: { thread_id: crypto.randomUUID() } }
    );

    const lastMessage = result?.messages?.[result.messages.length - 1];
    const response = typeof lastMessage?.content === 'string' ? lastMessage.content : String(lastMessage?.content || 'Done.');

    appState.sessionMemory.push({
      timestamp: Date.now(),
      task: transcript,
      result: response
    });

    return { ok: true, response };
  } catch (err) {
    console.error('[sw] handleWorkInstruction failed', err);
    return { ok: false, error: err && err.message ? err.message : String(err), response: '' };
  }
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function (_alarm) {
  // Intentional no-op; alarm wake keeps service worker alive.
});

chrome.runtime.onInstalled.addListener(function () {
  enableActionClickToOpenSidePanel().catch((err) => {
    console.error('[sw] onInstalled sidePanel setup failed', err);
  });
});

chrome.runtime.onStartup.addListener(function () {
  enableActionClickToOpenSidePanel().catch((err) => {
    console.error('[sw] onStartup sidePanel setup failed', err);
  });
});

chrome.action.onClicked.addListener(async function (tab) {
  try {
    await enableActionClickToOpenSidePanel();
    if (tab && typeof tab.windowId === 'number') {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.error('[sw] action click failed to open side panel', err);
  }
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status !== 'complete') {
    return;
  }
  if ((appState.mode === MODE_DEMO || appState.mode === MODE_WORK) && tabId === appState.activeTabId) {
    injectMainWorldScripts(tabId).catch(async (err) => {
      console.error('[sw] reinjection failed', err);
      await safeSendRuntimeMessage({
        type: 'STATUS_UPDATE',
        level: 'error',
        message: `Re-injection failed: ${err && err.message ? err.message : String(err)}`
      });
    });
  }
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
  if (appState.mode !== MODE_DEMO) {
    return;
  }
  if (typeof appState.activeTabId !== 'number') {
    return;
  }
  if (activeInfo.tabId === appState.activeTabId) {
    return;
  }
  maybeSendCaptureDiagStatus(
    `active tab switched to ${activeInfo.tabId}; demo capture remains bound to tab=${appState.activeTabId}`,
    'info',
    true
  );
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  (async function () {
    try {
      switch (message?.type) {
        case 'PING':
          sendResponse({ ok: true, mode: appState.mode });
          break;

        case 'GET_STATE':
          sendResponse({
            ok: true,
            state: {
              mode: appState.mode,
              activeTabId: appState.activeTabId,
              sessionMemoryLength: appState.sessionMemory.length
            }
          });
          break;

        case 'GET_SKILLS': {
          const skills = await loadAllSkills();
          sendResponse({
            ok: true,
            skills: Array.isArray(skills) ? skills : []
          });
          break;
        }

        case 'DELETE_SKILL': {
          await deleteSkill(message.storageKey);
          sendResponse({ ok: true });
          break;
        }

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

        case 'STOP_WORK':
          await stopWorkMode();
          sendResponse({ ok: true });
          break;

        case 'ACTION_BATCH':
          handleActionBatch(message, sender);
          sendResponse({ ok: true });
          break;

        case 'BRIDGE_ERROR':
          maybeSendCaptureDiagStatus(
            `bridge error source=${message?.sourceType || 'unknown'} tab=${sender?.tab?.id ?? 'n/a'} frame=${sender?.frameId ?? 'n/a'} error=${message?.error || 'unknown'}`,
            'error',
            true
          );
          sendResponse({ ok: true });
          break;

        case 'VOICE_SEGMENT': {
          const result = await handleVoiceSegment(message);
          sendResponse(result);
          break;
        }

        case 'WORK_INSTRUCTION': {
          const result = await handleWorkInstruction(message.transcript, message.tabId);
          sendResponse(result);
          break;
        }

        case 'EXECUTION_RESULT':
          handleExecutionResult(message);
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
      }
    } catch (err) {
      console.error('[sw] onMessage handler failed', { messageType: message?.type, err });
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })().catch((err) => {
    console.error('[sw] unhandled routing error', err);
    try {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    } catch (_err) {}
  });

  return true;
});
