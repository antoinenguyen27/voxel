import { writeSkillFromSegment, loadAllSkills, deleteSkill } from './skill-writer.js';
import { buildWorkAgent } from './work-agent.js';
import { createCdpRuntime } from './cdp-runtime.js';

const MODE_IDLE = 'idle';
const MODE_DEMO = 'demo';
const MODE_WORK = 'work';

const appState = {
  mode: MODE_IDLE,
  activeTabId: null,
  sessionMemory: [],
  demoStartedAt: 0,
  demoSegments: [],
  demoPageScaffold: null,
  demoActions: [],
  captureDiagnostics: {
    batchesReceived: 0,
    actionsReceived: 0,
    ignoredBatches: 0,
    byAction: {},
    lastStatusAt: 0
  }
};

const cdpRuntime = createCdpRuntime({
  logger(level, message) {
    safeSendRuntimeMessage({
      type: 'STATUS_UPDATE',
      level: level === 'error' ? 'error' : 'info',
      message
    }).catch(() => {});
  }
});

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

async function enableActionClickToOpenSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error('[sw] setPanelBehavior failed', err);
  }
}

async function safeSendRuntimeMessage(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (err) {
    console.error('[sw] safeSendRuntimeMessage failed', err);
  }
}

async function getInjectableTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    throw new Error('Cannot use this tab for automation');
  }
  return tab;
}

async function captureDemoPageContext(tabId) {
  if (typeof tabId !== 'number') {
    return null;
  }

  const result = await cdpRuntime.runCommand(tabId, 'INSPECT_PAGE_MAP', {
    mode: 'summary',
    depth: 4,
    maxNodes: 220
  });
  if (!result?.success) {
    return null;
  }
  return {
    summary: result.output || null,
    zooms: []
  };
}

async function sendCaptureDiagStatus(message, level = 'info') {
  await safeSendRuntimeMessage({
    type: 'STATUS_UPDATE',
    level,
    message: `[capture-diag] ${message}`
  });
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

async function startDemoMode(tabId) {
  try {
    await getInjectableTab(tabId);
    resetCaptureDiagnostics();
    appState.mode = MODE_DEMO;
    appState.activeTabId = tabId;
    appState.demoStartedAt = Date.now();
    appState.demoSegments = [];
    appState.demoActions = [];
    appState.demoPageScaffold = null;

    await withTimeout(cdpRuntime.startDemoCapture(tabId), 15000, 'CDP demo capture start');
    appState.demoPageScaffold = await captureDemoPageContext(tabId);

    await safeSendRuntimeMessage({ type: 'STATUS_UPDATE', level: 'info', message: 'Demo mode started.' });
    maybeSendCaptureDiagStatus(`capture pipeline armed for tab=${tabId}; waiting for VOICE_SEGMENT...`, 'info', true);
    if (appState.demoPageScaffold?.summary) {
      maybeSendCaptureDiagStatus(
        `captured demo scaffold title="${truncateForLog(appState.demoPageScaffold.summary.title || '', 80)}"`,
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

function normalizeRecordedActions(actions, demoStartedAt) {
  const normalized = [];
  const breakdown = {};
  for (const action of Array.isArray(actions) ? actions : []) {
    const actionType = action?.action || 'unknown';
    breakdown[actionType] = (breakdown[actionType] || 0) + 1;
    const absoluteTs = typeof action?.timestamp === 'number' ? action.timestamp : Date.now();
    const relativeTimestamp = Math.max(0, absoluteTs - demoStartedAt);
    normalized.push({
      ...action,
      timestamp: relativeTimestamp
    });
  }
  return { normalized, breakdown };
}

function assignEventsToSegments(segments, events) {
  const sortedSegments = segments.map((s, idx) => ({ ...s, __index: idx, events: [] }));
  const sortedEvents = events.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  for (const event of sortedEvents) {
    const ts = typeof event?.timestamp === 'number' ? event.timestamp : 0;
    let assigned = false;
    for (let i = 0; i < sortedSegments.length; i += 1) {
      const segment = sortedSegments[i];
      const end = Number.isFinite(segment.segmentEnd) ? segment.segmentEnd : null;
      if (end !== null && ts <= end) {
        segment.events.push(event);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      if (sortedSegments.length) {
        sortedSegments[sortedSegments.length - 1].events.push(event);
      } else {
        sortedSegments.push({
          transcript: '[No transcript captured]',
          segmentStart: 0,
          segmentEnd: ts,
          events: [event],
          __index: 0
        });
      }
    }
  }

  return sortedSegments.sort((a, b) => a.__index - b.__index);
}

async function stopDemoMode() {
  try {
    const tabId = appState.activeTabId;
    const demoStartedAt = appState.demoStartedAt || Date.now();

    const recorded = await withTimeout(cdpRuntime.stopDemoCapture(tabId), 15000, 'CDP demo capture stop');
    const { normalized: normalizedEvents, breakdown } = normalizeRecordedActions(recorded, demoStartedAt);

    appState.demoActions = normalizedEvents;
    appState.captureDiagnostics.actionsReceived = normalizedEvents.length;
    appState.captureDiagnostics.byAction = breakdown;

    let demoSegments = assignEventsToSegments(appState.demoSegments, normalizedEvents);

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

    appState.mode = MODE_IDLE;
    appState.activeTabId = null;
    appState.demoStartedAt = 0;
    appState.demoSegments = [];
    appState.demoPageScaffold = null;
    appState.demoActions = [];

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

async function handleVoiceSegment(message) {
  try {
    if (appState.mode !== MODE_DEMO) {
      return { ok: false, skipped: true, reason: 'Not in demo mode.' };
    }

    const transcript = String(message.transcript || '').trim();
    if (!transcript) {
      return { ok: false, skipped: true, reason: 'Empty transcript.' };
    }

    const segmentStartAbsolute =
      typeof message.segmentStart === 'number' && Number.isFinite(message.segmentStart) ? message.segmentStart : null;
    const segmentEndAbsolute =
      typeof message.segmentEnd === 'number' && Number.isFinite(message.segmentEnd) ? message.segmentEnd : null;

    const segmentStart =
      segmentStartAbsolute === null
        ? null
        : Math.max(0, segmentStartAbsolute - (appState.demoStartedAt || segmentStartAbsolute));
    const segmentEnd =
      segmentEndAbsolute === null ? null : Math.max(0, segmentEndAbsolute - (appState.demoStartedAt || segmentEndAbsolute));

    appState.demoSegments.push({
      transcript,
      segmentStart,
      segmentEnd,
      events: []
    });

    return {
      ok: true,
      buffered: true,
      segmentCount: appState.demoSegments.length,
      eventCount: 0
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
    await getInjectableTab(tabId);
    appState.mode = MODE_WORK;
    appState.activeTabId = tabId;
    appState.sessionMemory = [];
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
    const tabId = appState.activeTabId;
    appState.mode = MODE_IDLE;
    appState.sessionMemory = [];
    appState.activeTabId = null;
    if (typeof tabId === 'number') {
      await cdpRuntime.cleanupTab(tabId);
    }
    await safeSendRuntimeMessage({ type: 'STATUS_UPDATE', level: 'info', message: 'Work mode stopped.' });
  } catch (err) {
    console.error('[sw] stopWorkMode failed', err);
    throw err;
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

    await cdpRuntime.beginTask(targetTabId, transcript || 'work_instruction');

    const emitToolEvent = async (event) => {
      try {
        const phase = event?.phase === 'finish' ? 'finish' : 'start';
        const tool = event?.tool || 'unknown_tool';
        if (phase === 'start') {
          await safeSendRuntimeMessage({
            type: 'STATUS_UPDATE',
            level: 'info',
            message: `[work-tool] ${tool} start input=${truncateForLog(JSON.stringify(event?.input || {}), 320)}`
          });
          return;
        }
        await safeSendRuntimeMessage({
          type: 'STATUS_UPDATE',
          level: event?.ok ? 'info' : 'error',
          message:
            `[work-tool] ${tool} finish ${event?.summary || ''}` +
            ` output=${truncateForLog(String(event?.outputPreview || ''), 320)}`
        });
      } catch (err) {
        console.error('[sw] emitToolEvent failed', err);
      }
    };

    const executeExecutorCommand = async ({ tabId: tabIdFromTool, command, args, timeoutMs }) => {
      const usedTabId = typeof tabIdFromTool === 'number' ? tabIdFromTool : targetTabId;
      const commandResult = await cdpRuntime.runCommand(usedTabId, command, args || {}, timeoutMs);
      return commandResult;
    };

    const agent = await buildWorkAgent({
      tabId: targetTabId,
      executeExecutorCommand,
      loadAllSkills,
      reportToolEvent: emitToolEvent,
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
  } finally {
    const targetTabId = typeof tabId === 'number' ? tabId : appState.activeTabId;
    if (typeof targetTabId === 'number') {
      await cdpRuntime.endTask(targetTabId).catch(() => {});
    }
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
          appState.captureDiagnostics.ignoredBatches += 1;
          maybeSendCaptureDiagStatus(
            `ignored legacy ACTION_BATCH while mode=${appState.mode}; tab=${sender?.tab?.id ?? 'n/a'} frame=${sender?.frameId ?? 'n/a'}`,
            'info'
          );
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
