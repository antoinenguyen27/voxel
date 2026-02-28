const PROTOCOL_VERSION = '1.3';
const DEFAULT_TIMEOUT_MS = 12000;
const BINDING_NAME = 'uaRecordAction';

function now() {
  return Date.now();
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.min(30000, Math.floor(n)));
}

function makeError(errorCode, error, output = null) {
  return {
    success: false,
    errorCode,
    error,
    output
  };
}

function summarizeText(value, max = 120) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function getActionType(action) {
  return action && typeof action.type === 'string' ? action.type : 'unknown';
}

function isVisibleRect(rect) {
  return !!rect && Number(rect.width) > 0 && Number(rect.height) > 0;
}

function buildRecorderInstallScript() {
  return `(() => {
    if (window.__uaCdpRecorderInstalled) return 'already-installed';
    window.__uaCdpRecorderInstalled = true;
    const emit = (payload) => {
      try {
        const safe = JSON.stringify(payload);
        if (typeof window.${BINDING_NAME} === 'function') {
          window.${BINDING_NAME}(safe);
        }
      } catch (_err) {}
    };

    const stableSelector = (el) => {
      if (!el || el.nodeType !== 1) return null;
      if (el.id) return '#' + CSS.escape(el.id);
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
      const name = el.getAttribute && (el.getAttribute('name') || el.getAttribute('placeholder'));
      if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      return el.tagName ? el.tagName.toLowerCase() : null;
    };

    const makeBase = (target) => ({
      selector: stableSelector(target),
      tag: target && target.tagName ? target.tagName.toLowerCase() : null,
      ariaLabel: target && target.getAttribute ? target.getAttribute('aria-label') : null,
      innerText: target ? String(target.innerText || '').slice(0, 120) : null,
      ts: Date.now(),
      href: location.href
    });

    document.addEventListener('click', (event) => {
      emit({ action: 'click', ...makeBase(event.target) });
    }, true);

    document.addEventListener('keydown', (event) => {
      emit({
        action: 'keyboard',
        ...makeBase(event.target),
        eventType: 'keydown',
        key: event.key,
        code: event.code,
        ctrlKey: !!event.ctrlKey,
        metaKey: !!event.metaKey,
        altKey: !!event.altKey,
        shiftKey: !!event.shiftKey
      });
    }, true);

    document.addEventListener('input', (event) => {
      const target = event.target;
      const value = target && ('value' in target) ? target.value : (target && target.textContent ? target.textContent : '');
      emit({ action: 'fill', ...makeBase(target), value: String(value || '').slice(0, 400) });
    }, true);

    return 'installed';
  })();`;
}

function buildInspectExpression(args) {
  const mode = args?.mode === 'zoom' ? 'zoom' : 'summary';
  const targetSelector = typeof args?.targetSelector === 'string' ? args.targetSelector : '';
  const maxNodes = Number.isFinite(args?.maxNodes) ? Math.max(20, Math.min(500, Math.floor(args.maxNodes))) : 180;
  return `(() => {
    const mode = ${JSON.stringify(mode)};
    const targetSelector = ${JSON.stringify(targetSelector)};
    const maxNodes = ${JSON.stringify(maxNodes)};

    const getSimpleSelector = (el) => {
      if (!el || el.nodeType !== 1) return null;
      if (el.id) return '#' + CSS.escape(el.id);
      const aria = el.getAttribute('aria-label');
      if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
      if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.getAttribute('name')) + '"]';
      if (el.classList && el.classList.length) {
        const cls = Array.from(el.classList).slice(0, 2).join('.');
        if (cls) return el.tagName.toLowerCase() + '.' + cls;
      }
      return el.tagName ? el.tagName.toLowerCase() : null;
    };

    const root = mode === 'zoom' && targetSelector ? document.querySelector(targetSelector) : (document.body || document.documentElement);
    const targetFound = mode === 'zoom' && !!targetSelector ? !!root : false;
    const nodes = [];
    const pushNode = (el) => {
      if (!el || !el.tagName) return;
      const role = el.getAttribute('role') || null;
      const tag = el.tagName.toLowerCase();
      const label = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || null;
      const interactive = ['button','a','input','textarea','select'].includes(tag) || ['button','textbox','menuitem','link','tab','checkbox','radio','combobox'].includes(String(role || '').toLowerCase()) || el.hasAttribute('contenteditable');
      nodes.push({
        tag,
        role,
        selector: getSimpleSelector(el),
        label: label ? String(label).slice(0, 80) : null,
        text: String(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        interactive
      });
    };

    const walker = document.createTreeWalker(root || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let count = 0;
    while (walker.nextNode() && count < maxNodes) {
      pushNode(walker.currentNode);
      count += 1;
    }

    const interactive = nodes.filter((n) => n.interactive).slice(0, Math.floor(maxNodes * 0.6));
    const landmarks = nodes.filter((n) => ['main','nav','section','form','table','header','footer','aside'].includes(n.tag)).slice(0, 60);

    return {
      mode,
      url: location.href,
      title: document.title || '',
      focusedSelector: getSimpleSelector(document.activeElement),
      targetSelector: targetSelector || null,
      targetFound,
      frameSummary: {
        totalNodes: nodes.length,
        interactiveCount: interactive.length,
        interactive,
        landmarks
      }
    };
  })();`;
}

function buildContextExpression(selector, options = {}) {
  const radius = Number.isFinite(options.radius) ? Math.max(1, Math.min(6, Math.floor(options.radius))) : 3;
  const maxSiblings = Number.isFinite(options.maxSiblings)
    ? Math.max(2, Math.min(20, Math.floor(options.maxSiblings)))
    : 8;
  const maxChildren = Number.isFinite(options.maxChildren)
    ? Math.max(4, Math.min(40, Math.floor(options.maxChildren)))
    : 16;

  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const radius = ${JSON.stringify(radius)};
    const maxSiblings = ${JSON.stringify(maxSiblings)};
    const maxChildren = ${JSON.stringify(maxChildren)};

    const getSimpleSelector = (el) => {
      if (!el || el.nodeType !== 1) return null;
      if (el.id) return '#' + CSS.escape(el.id);
      const aria = el.getAttribute('aria-label');
      if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
      if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.getAttribute('name')) + '"]';
      return el.tagName ? el.tagName.toLowerCase() : null;
    };

    const getInfo = (el) => {
      if (!el || !el.tagName) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        selector: getSimpleSelector(el),
        ariaLabel: el.getAttribute('aria-label') || null,
        name: el.getAttribute('name') || null,
        placeholder: el.getAttribute('placeholder') || null,
        text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
      };
    };

    let target = null;
    try {
      target = document.querySelector(selector);
    } catch (_err) {
      target = null;
    }

    const result = {
      url: location.href,
      frameTitle: document.title || '',
      requestedSelector: selector,
      found: !!target,
      target: getInfo(target),
      ancestry: [],
      siblings: [],
      descendants: []
    };

    if (!target) return result;

    let current = target.parentElement;
    let depth = 0;
    while (current && depth < radius) {
      const info = getInfo(current);
      if (info) result.ancestry.push(info);
      current = current.parentElement;
      depth += 1;
    }

    const siblingNodes = Array.from((target.parentElement && target.parentElement.children) || []).filter((el) => el !== target).slice(0, maxSiblings);
    result.siblings = siblingNodes.map(getInfo).filter(Boolean);

    const childNodes = Array.from(target.querySelectorAll('*')).slice(0, maxChildren);
    result.descendants = childNodes.map(getInfo).filter(Boolean);

    return result;
  })();`;
}

function buildSelectorProbeExpression(selector) {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    let target = null;
    try { target = document.querySelector(selector); } catch (_err) { target = null; }
    if (!target) {
      return { found: false, selector, url: location.href };
    }
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    const value = 'value' in target ? String(target.value || '') : null;
    return {
      found: true,
      selector,
      url: location.href,
      tag: target.tagName ? target.tagName.toLowerCase() : null,
      role: target.getAttribute ? target.getAttribute('role') : null,
      ariaLabel: target.getAttribute ? target.getAttribute('aria-label') : null,
      text: String(target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      value,
      contentEditable: !!target.isContentEditable,
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      rect: {
        x: Number(rect.x) || 0,
        y: Number(rect.y) || 0,
        width: Number(rect.width) || 0,
        height: Number(rect.height) || 0
      }
    };
  })();`;
}

function buildActionExpression(action) {
  const selector = typeof action?.selector === 'string' ? action.selector : '';
  const value = typeof action?.value === 'string' ? action.value : '';
  const text = typeof action?.text === 'string' ? action.text : '';
  const optionValue = typeof action?.value === 'string' ? action.value : '';

  const actionType = getActionType(action);
  if (actionType === 'fill') {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'TARGET_NOT_FOUND' };
      if (el.isContentEditable) {
        el.focus();
        el.textContent = ${JSON.stringify(value)};
      } else if ('value' in el) {
        el.focus();
        el.value = ${JSON.stringify(value)};
      } else {
        el.textContent = ${JSON.stringify(value)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
      const current = el.isContentEditable ? String(el.textContent || '') : ('value' in el ? String(el.value || '') : String(el.textContent || ''));
      return { ok: true, current: current.slice(0, 500) };
    })();`;
  }

  if (actionType === 'selectOptions') {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'TARGET_NOT_FOUND' };
      if (!(el instanceof HTMLSelectElement)) return { ok: false, reason: 'NOT_SELECT' };
      el.focus();
      el.value = ${JSON.stringify(optionValue)};
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
      return { ok: true, current: String(el.value || '') };
    })();`;
  }

  if (actionType === 'type') {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'TARGET_NOT_FOUND' };
      el.focus();
      if (el.isContentEditable) {
        document.execCommand('insertText', false, ${JSON.stringify(text)});
      } else if ('value' in el) {
        el.value = String(el.value || '') + ${JSON.stringify(text)};
      } else {
        el.textContent = String(el.textContent || '') + ${JSON.stringify(text)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
      const current = el.isContentEditable ? String(el.textContent || '') : ('value' in el ? String(el.value || '') : String(el.textContent || ''));
      return { ok: true, current: current.slice(0, 500) };
    })();`;
  }

  if (actionType === 'readText') {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'TARGET_NOT_FOUND' };
      return { ok: true, text: String(el.innerText || el.textContent || '').slice(0, 1000) };
    })();`;
  }

  return null;
}

function parseEvaluateResult(result) {
  if (!result || !result.result) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(result.result, 'value')) {
    return result.result.value;
  }
  if (result.result.description) {
    return result.result.description;
  }
  return null;
}

export function createCdpRuntime({ logger } = {}) {
  const tabState = new Map();
  const attachLocks = new Map();

  function log(level, message) {
    if (typeof logger === 'function') {
      logger(level, message);
      return;
    }
    if (level === 'error') {
      console.error(message);
      return;
    }
    console.log(message);
  }

  function getOrCreateState(tabId) {
    let state = tabState.get(tabId);
    if (state) {
      return state;
    }
    state = {
      attached: false,
      attaching: false,
      taskRefs: 0,
      recording: false,
      contexts: new Map(),
      frameUrls: new Map(),
      frameTree: null,
      recorderScriptId: null,
      recordedActions: [],
      correlationId: null,
      attachStartedAt: 0
    };
    tabState.set(tabId, state);
    return state;
  }

  async function send(tabId, method, params = {}) {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  }

  function registerEventHandlers() {
    if (registerEventHandlers._installed) {
      return;
    }
    registerEventHandlers._installed = true;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      const tabId = source?.tabId;
      if (typeof tabId !== 'number') {
        return;
      }
      const state = tabState.get(tabId);
      if (!state) {
        return;
      }

      try {
        if (method === 'Runtime.executionContextCreated') {
          const ctx = params?.context;
          const contextId = ctx?.id;
          if (typeof contextId === 'number') {
            const frameId = ctx?.auxData?.frameId || null;
            state.contexts.set(contextId, {
              contextId,
              frameId,
              name: ctx?.name || '',
              origin: ctx?.origin || ''
            });
          }
        } else if (method === 'Runtime.executionContextDestroyed') {
          const contextId = params?.executionContextId;
          state.contexts.delete(contextId);
        } else if (method === 'Runtime.executionContextsCleared') {
          state.contexts.clear();
        } else if (method === 'Page.frameNavigated') {
          const frame = params?.frame;
          if (frame?.id) {
            state.frameUrls.set(frame.id, frame.url || '');
          }
        } else if (method === 'Runtime.bindingCalled' && params?.name === BINDING_NAME && state.recording) {
          const executionContextId = params?.executionContextId;
          const ctx = state.contexts.get(executionContextId);
          let payload = null;
          try {
            payload = JSON.parse(params?.payload || '{}');
          } catch (_err) {
            payload = null;
          }
          if (payload && typeof payload === 'object') {
            state.recordedActions.push({
              ...payload,
              frameId: ctx?.frameId ?? null,
              contextId: executionContextId,
              timestamp: Number(payload.ts) || now()
            });
          }
        } else if (method === 'Network.responseReceived' && state.recording) {
          const response = params?.response;
          const request = params?.request;
          if (!response) {
            return;
          }
          state.recordedActions.push({
            action: 'network',
            method: request?.method || null,
            url: response.url || null,
            status: response.status || null,
            frameId: params?.frameId || null,
            timestamp: now()
          });
        }
      } catch (err) {
        log('error', `[cdp-session] event handler failed: ${err?.message || String(err)}`);
      }
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
      const tabId = source?.tabId;
      if (typeof tabId !== 'number') {
        return;
      }
      const state = tabState.get(tabId);
      if (!state) {
        return;
      }
      state.attached = false;
      state.contexts.clear();
      state.frameTree = null;
      state.frameUrls.clear();
      state.recorderScriptId = null;
      state.recording = false;
      log('info', `[cdp-session] detached tab=${tabId} reason=${reason || 'unknown'}`);
    });
  }

  async function attachIfNeeded(tabId) {
    registerEventHandlers();
    const state = getOrCreateState(tabId);
    if (state.attached) {
      return state;
    }

    if (attachLocks.has(tabId)) {
      await attachLocks.get(tabId);
      return getOrCreateState(tabId);
    }

    const lock = (async () => {
      state.attaching = true;
      state.correlationId = crypto.randomUUID();
      state.attachStartedAt = now();
      try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
        await send(tabId, 'Page.enable');
        await send(tabId, 'DOM.enable');
        await send(tabId, 'Runtime.enable');
        await send(tabId, 'Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
        await send(tabId, 'Network.enable');
        await send(tabId, 'Accessibility.enable').catch(() => {});
        await send(tabId, 'Runtime.addBinding', { name: BINDING_NAME });
        const frameTree = await send(tabId, 'Page.getFrameTree');
        state.frameTree = frameTree?.frameTree || null;
        state.attached = true;
        log('info', `[cdp-session] attached tab=${tabId} correlation=${state.correlationId}`);
      } catch (err) {
        state.attached = false;
        throw err;
      } finally {
        state.attaching = false;
      }
    })();

    attachLocks.set(tabId, lock);
    try {
      await lock;
    } finally {
      attachLocks.delete(tabId);
    }
    return getOrCreateState(tabId);
  }

  async function detachIfIdle(tabId) {
    const state = getOrCreateState(tabId);
    if (!state.attached) {
      return;
    }
    if (state.taskRefs > 0 || state.recording) {
      return;
    }
    try {
      await chrome.debugger.detach({ tabId });
      state.attached = false;
      state.contexts.clear();
      state.frameTree = null;
      state.frameUrls.clear();
      state.recorderScriptId = null;
      log('info', `[cdp-session] detached tab=${tabId} correlation=${state.correlationId || 'n/a'}`);
    } catch (err) {
      log('error', `[cdp-session] detach failed tab=${tabId}: ${err?.message || String(err)}`);
    }
  }

  async function evaluate(tabId, expression, contextId = null) {
    const params = {
      expression,
      returnByValue: true,
      awaitPromise: true,
      replMode: false
    };
    if (typeof contextId === 'number') {
      params.contextId = contextId;
    }
    return await send(tabId, 'Runtime.evaluate', params);
  }

  async function getContextOrder(tabId) {
    const state = getOrCreateState(tabId);
    const entries = Array.from(state.contexts.values());
    if (!entries.length) {
      return [null];
    }

    entries.sort((a, b) => {
      if (a.frameId === b.frameId) {
        return a.contextId - b.contextId;
      }
      if (a.frameId == null) return 1;
      if (b.frameId == null) return -1;
      return String(a.frameId).localeCompare(String(b.frameId));
    });

    return entries.map((entry) => entry.contextId);
  }

  async function resolveSelector(tabId, selector) {
    const contextOrder = await getContextOrder(tabId);
    const expression = buildSelectorProbeExpression(selector);

    for (const contextId of contextOrder) {
      try {
        const result = await evaluate(tabId, expression, contextId);
        const payload = parseEvaluateResult(result);
        if (payload && payload.found) {
          const state = getOrCreateState(tabId);
          const context = typeof contextId === 'number' ? state.contexts.get(contextId) : null;
          const frameId = context?.frameId || null;
          log(
            'info',
            `[cdp-resolve] selector=${summarizeText(selector, 120)} found=true frameId=${frameId ?? 'n/a'} contextId=${contextId ?? 'n/a'}`
          );
          return {
            found: true,
            contextId,
            frameId,
            ...payload
          };
        }
      } catch (_err) {
        // keep scanning contexts
      }
    }

    log('info', `[cdp-resolve] selector=${summarizeText(selector, 120)} found=false`);
    return { found: false, selector };
  }

  async function inspectPageMap(tabId, args = {}) {
    await attachIfNeeded(tabId);
    const state = getOrCreateState(tabId);
    const contexts = await getContextOrder(tabId);
    const frameSummaries = [];

    for (const contextId of contexts) {
      try {
        const payload = parseEvaluateResult(await evaluate(tabId, buildInspectExpression(args), contextId));
        if (!payload) {
          continue;
        }
        const ctx = typeof contextId === 'number' ? state.contexts.get(contextId) : null;
        frameSummaries.push({
          mode: `${payload.mode}:${ctx ? 'frame' : 'top'}`,
          frameId: ctx?.frameId ?? 0,
          frameUrl: payload.url,
          frameTitle: payload.title,
          totalNodes: payload.frameSummary?.totalNodes || 0,
          interactiveCount: payload.frameSummary?.interactiveCount || 0,
          landmarks: payload.frameSummary?.landmarks || [],
          interactive: payload.frameSummary?.interactive || []
        });
      } catch (_err) {
        // ignore inaccessible contexts
      }
    }

    const first = frameSummaries[0] || null;
    return {
      mode: args?.mode === 'zoom' ? 'zoom' : 'summary',
      url: first?.frameUrl || '',
      title: first?.frameTitle || '',
      focusedSelector: null,
      targetSelector: typeof args?.targetSelector === 'string' ? args.targetSelector : null,
      targetFound: frameSummaries.some((entry) => {
        if (!args?.targetSelector) {
          return false;
        }
        return (entry.interactive || []).some((n) => n.selector === args.targetSelector);
      }),
      frameSummaries
    };
  }

  async function getActionContext(tabId, args = {}) {
    await attachIfNeeded(tabId);
    const selector = typeof args?.selector === 'string' ? args.selector : '';
    if (!selector) {
      return makeError('VALIDATION_ERROR', 'selector is required for GET_ACTION_CONTEXT');
    }

    const expression = buildContextExpression(selector, args);
    const contexts = await getContextOrder(tabId);

    for (const contextId of contexts) {
      try {
        const payload = parseEvaluateResult(await evaluate(tabId, expression, contextId));
        if (payload && payload.found) {
          const state = getOrCreateState(tabId);
          const ctx = typeof contextId === 'number' ? state.contexts.get(contextId) : null;
          return {
            success: true,
            output: {
              ...payload,
              frameId: ctx?.frameId ?? null
            }
          };
        }
      } catch (_err) {
        // continue
      }
    }

    return {
      success: true,
      output: {
        url: '',
        frameTitle: '',
        requestedSelector: selector,
        found: false,
        target: null,
        ancestry: [],
        siblings: [],
        descendants: []
      }
    };
  }

  async function executeAction(tabId, action) {
    const actionType = getActionType(action);
    const result = {
      attempted: true,
      executed: false,
      verified: false,
      evidence: '',
      type: actionType,
      selector: action?.selector || null,
      value: action?.value || null,
      text: action?.text || null
    };

    if (actionType === 'delay') {
      const ms = Number.isFinite(action?.ms) ? Math.max(0, Math.min(20000, Math.floor(action.ms))) : 250;
      await new Promise((resolve) => setTimeout(resolve, ms));
      result.executed = true;
      result.verified = true;
      result.evidence = `delay ${ms}ms`;
      log('info', `[cdp-action] type=delay executed=true verified=true evidence=${result.evidence}`);
      return result;
    }

    if (actionType === 'keyboard') {
      const key = typeof action?.key === 'string' ? action.key : '';
      if (!key) {
        result.errorCode = 'VALIDATION_ERROR';
        result.error = 'keyboard action requires key';
        return result;
      }
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, text: key.length === 1 ? key : undefined });
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key });
      result.executed = true;
      result.verified = true;
      result.evidence = `keyboard ${key}`;
      log('info', `[cdp-action] type=keyboard key=${summarizeText(key, 20)} executed=true verified=true`);
      return result;
    }

    const selector = typeof action?.selector === 'string' ? action.selector : '';
    if (!selector) {
      result.errorCode = 'VALIDATION_ERROR';
      result.error = `${actionType} action requires selector`;
      return result;
    }

    if (actionType === 'waitForElement') {
      const timeoutMs = Number.isFinite(action?.timeoutMs)
        ? Math.max(250, Math.min(20000, Math.floor(action.timeoutMs)))
        : 5000;
      const startedAt = now();
      while (now() - startedAt < timeoutMs) {
        const resolved = await resolveSelector(tabId, selector);
        if (resolved.found) {
          result.executed = true;
          result.verified = true;
          result.evidence = `found in ${Math.max(1, now() - startedAt)}ms`;
          log('info', `[cdp-action] type=waitForElement selector=${summarizeText(selector, 100)} verified=true`);
          return result;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      result.errorCode = 'TIMEOUT';
      result.error = `Timeout waiting for selector: ${selector}`;
      result.evidence = 'not found before timeout';
      log('info', `[cdp-action] type=waitForElement selector=${summarizeText(selector, 100)} verified=false error=TIMEOUT`);
      return result;
    }

    const resolved = await resolveSelector(tabId, selector);
    if (!resolved.found) {
      result.errorCode = 'TARGET_NOT_RESOLVED';
      result.error = `Selector not found: ${selector}`;
      result.evidence = 'resolver did not find target in any context';
      log('info', `[cdp-action] type=${actionType} selector=${summarizeText(selector, 100)} verified=false error=TARGET_NOT_RESOLVED`);
      return result;
    }

    const contextId = resolved.contextId;

    if (actionType === 'click') {
      if (!isVisibleRect(resolved.rect)) {
        result.errorCode = 'NOT_INTERACTABLE';
        result.error = `Target is not visible: ${selector}`;
        result.evidence = 'target rect is not visible';
        return result;
      }
      const x = Math.round(resolved.rect.x + resolved.rect.width / 2);
      const y = Math.round(resolved.rect.y + resolved.rect.height / 2);
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      result.executed = true;
      result.verified = true;
      result.evidence = `clicked at (${x}, ${y})`;
      log('info', `[cdp-action] type=click selector=${summarizeText(selector, 100)} executed=true verified=true`);
      return result;
    }

    const expression = buildActionExpression(action);
    if (!expression) {
      result.errorCode = 'VALIDATION_ERROR';
      result.error = `Unsupported action type: ${actionType}`;
      return result;
    }

    const evalResult = parseEvaluateResult(await evaluate(tabId, expression, contextId));
    if (!evalResult || !evalResult.ok) {
      result.errorCode = evalResult?.reason || 'EXECUTION_ERROR';
      result.error = `Failed to execute ${actionType}`;
      result.evidence = summarizeText(JSON.stringify(evalResult || {}), 200);
      log(
        'info',
        `[cdp-action] type=${actionType} selector=${summarizeText(selector, 100)} executed=false verified=false error=${result.errorCode}`
      );
      return result;
    }

    result.executed = true;

    if (actionType === 'readText') {
      result.verified = true;
      result.evidence = summarizeText(evalResult.text || '', 180);
      result.readText = evalResult.text || '';
      log('info', `[cdp-action] type=readText selector=${summarizeText(selector, 100)} verified=true`);
      return result;
    }

    if (actionType === 'fill') {
      const expected = typeof action?.value === 'string' ? action.value : '';
      result.verified = typeof evalResult.current === 'string' && evalResult.current.includes(expected);
      result.evidence = summarizeText(`current="${evalResult.current || ''}"`, 220);
      if (!result.verified) {
        result.errorCode = 'VERIFY_FAILED';
        result.error = `Verification failed for fill on ${selector}`;
      }
      log(
        'info',
        `[cdp-verify] type=fill selector=${summarizeText(selector, 100)} verified=${result.verified} evidence=${summarizeText(result.evidence, 120)}`
      );
      return result;
    }

    if (actionType === 'type') {
      const expectedText = typeof action?.text === 'string' ? action.text : '';
      result.verified = typeof evalResult.current === 'string' && evalResult.current.includes(expectedText);
      result.evidence = summarizeText(`current="${evalResult.current || ''}"`, 220);
      if (!result.verified) {
        result.errorCode = 'VERIFY_FAILED';
        result.error = `Verification failed for type on ${selector}`;
      }
      log(
        'info',
        `[cdp-verify] type=type selector=${summarizeText(selector, 100)} verified=${result.verified} evidence=${summarizeText(result.evidence, 120)}`
      );
      return result;
    }

    if (actionType === 'selectOptions') {
      const expectedValue = typeof action?.value === 'string' ? action.value : '';
      result.verified = String(evalResult.current || '') === expectedValue;
      result.evidence = summarizeText(`current="${evalResult.current || ''}"`, 220);
      if (!result.verified) {
        result.errorCode = 'VERIFY_FAILED';
        result.error = `Verification failed for selectOptions on ${selector}`;
      }
      log(
        'info',
        `[cdp-verify] type=selectOptions selector=${summarizeText(selector, 100)} verified=${result.verified} evidence=${summarizeText(result.evidence, 120)}`
      );
      return result;
    }

    result.verified = true;
    result.evidence = 'action executed';
    log('info', `[cdp-action] type=${actionType} selector=${summarizeText(selector, 100)} executed=true verified=true`);
    return result;
  }

  async function runActions(tabId, args = {}) {
    await attachIfNeeded(tabId);
    const actions = Array.isArray(args?.actions) ? args.actions : [];
    if (!actions.length) {
      return makeError('VALIDATION_ERROR', 'RUN_ACTIONS requires at least one action');
    }
    if (actions.length > 25) {
      return makeError('VALIDATION_ERROR', 'RUN_ACTIONS supports up to 25 actions');
    }

    const results = [];
    const executed = [];
    let allVerified = true;
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      const outcome = await executeAction(tabId, action);
      results.push({ index: i, ...outcome });
      if (outcome.executed) {
        executed.push({ index: i, type: getActionType(action), selector: action?.selector || null });
      }
      if (!outcome.verified) {
        allVerified = false;
        break;
      }
    }

    const output = {
      summary: typeof args?.summary === 'string' ? args.summary : '',
      attempted: actions.length,
      executedCount: results.filter((r) => r.executed).length,
      verifiedCount: results.filter((r) => r.verified).length,
      allVerified,
      results,
      executed
    };

    if (!allVerified) {
      const firstFailed = results.find((r) => !r.verified);
      return {
        success: false,
        errorCode: firstFailed?.errorCode || 'VERIFY_FAILED',
        error: firstFailed?.error || 'One or more actions were not verified',
        output
      };
    }

    return {
      success: true,
      output
    };
  }

  async function beginTask(tabId, reason = '') {
    const state = await attachIfNeeded(tabId);
    state.taskRefs += 1;
    log('info', `[cdp-session] begin task tab=${tabId} refs=${state.taskRefs} reason=${summarizeText(reason, 100)}`);
  }

  async function endTask(tabId) {
    const state = getOrCreateState(tabId);
    if (state.taskRefs > 0) {
      state.taskRefs -= 1;
    }
    log('info', `[cdp-session] end task tab=${tabId} refs=${state.taskRefs}`);
    await detachIfIdle(tabId);
  }

  async function ensureRecorderInstalled(tabId) {
    const state = getOrCreateState(tabId);
    const expression = buildRecorderInstallScript();

    const contexts = await getContextOrder(tabId);
    for (const contextId of contexts) {
      try {
        await evaluate(tabId, expression, contextId);
      } catch (_err) {
        // ignore
      }
    }

    if (!state.recorderScriptId) {
      try {
        const result = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', {
          source: buildRecorderInstallScript()
        });
        state.recorderScriptId = result?.identifier || null;
      } catch (err) {
        log('error', `[cdp-session] failed to add recorder bootstrap script: ${err?.message || String(err)}`);
      }
    }
  }

  async function startDemoCapture(tabId) {
    await attachIfNeeded(tabId);
    await ensureRecorderInstalled(tabId);
    const state = getOrCreateState(tabId);
    state.recordedActions = [];
    state.recording = true;
    log('info', `[cdp-session] demo capture started tab=${tabId}`);
  }

  async function stopDemoCapture(tabId) {
    const state = getOrCreateState(tabId);
    state.recording = false;
    const actions = state.recordedActions.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    state.recordedActions = [];
    await detachIfIdle(tabId);
    log('info', `[cdp-session] demo capture stopped tab=${tabId} actions=${actions.length}`);
    return actions;
  }

  async function runCommand(tabId, command, args = {}, timeoutMs) {
    const timeoutValue = clampTimeout(timeoutMs);
    const op = (async () => {
      await attachIfNeeded(tabId);
      if (command === 'INSPECT_PAGE_MAP') {
        const output = await inspectPageMap(tabId, args);
        return { success: true, output };
      }
      if (command === 'GET_ACTION_CONTEXT') {
        return await getActionContext(tabId, args);
      }
      if (command === 'RUN_ACTIONS') {
        return await runActions(tabId, args);
      }
      return makeError('COMMAND_NOT_SUPPORTED', `Unsupported command: ${command}`);
    })();

    const timer = new Promise((resolve) => {
      setTimeout(() => {
        resolve(makeError('TIMEOUT', `Timeout: ${String(command || 'command')} did not complete in ${Math.round(timeoutValue / 1000)}s`));
      }, timeoutValue);
    });

    return await Promise.race([op, timer]);
  }

  async function cleanupTab(tabId) {
    const state = getOrCreateState(tabId);
    state.recording = false;
    state.taskRefs = 0;
    await detachIfIdle(tabId);
  }

  return {
    beginTask,
    endTask,
    startDemoCapture,
    stopDemoCapture,
    runCommand,
    cleanupTab
  };
}
