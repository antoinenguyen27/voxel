import { writeSkillFromSegment, loadAllSkills } from './skill-writer.js';
import { buildWorkAgent } from './work-agent.js';

const MODE_IDLE = 'idle';
const MODE_DEMO = 'demo';
const MODE_WORK = 'work';

const appState = {
  mode: MODE_IDLE,
  activeTabId: null,
  sessionMemory: [],
  pendingBatch: []
};

const pendingExecutions = new Map();

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

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [`${prefix}lib/selector.js`],
      world: 'MAIN'
    });

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [`${prefix}content/capture.js`],
      world: 'MAIN'
    });

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [`${prefix}content/executor.js`],
      world: 'MAIN'
    });
  } catch (err) {
    console.error('[sw] injectMainWorldScripts failed', { tabId, err });
    throw err;
  }
}

async function startDemoMode(tabId) {
  try {
    appState.mode = MODE_DEMO;
    appState.activeTabId = tabId;
    appState.pendingBatch = [];
    await injectMainWorldScripts(tabId);
    await safeSendRuntimeMessage({ type: 'STATUS_UPDATE', level: 'info', message: 'Demo mode started.' });
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
    appState.mode = MODE_IDLE;
    appState.activeTabId = null;
    appState.pendingBatch = [];
    await safeSendTabMessage(tabId, { type: 'STOP_CAPTURE' });
    await safeSendRuntimeMessage({ type: 'STATUS_UPDATE', level: 'info', message: 'Demo mode stopped.' });
  } catch (err) {
    console.error('[sw] stopDemoMode failed', err);
    throw err;
  }
}

function handleActionBatch(message) {
  try {
    if (appState.mode !== MODE_DEMO) {
      return;
    }
    if (!Array.isArray(message.events)) {
      return;
    }
    appState.pendingBatch.push(...message.events);
  } catch (err) {
    console.error('[sw] handleActionBatch failed', err);
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

    const events = appState.pendingBatch.splice(0, appState.pendingBatch.length);
    if (!events.length) {
      return { ok: true, skipped: true, reason: 'No captured events for segment.' };
    }

    const skillName = await writeSkillFromSegment(transcript, events);
    await safeSendRuntimeMessage({
      type: 'STATUS_UPDATE',
      level: 'success',
      message: `Saved skill: ${skillName}`
    });
    return { ok: true, skillName };
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
    await injectMainWorldScripts(tabId);
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
