(function () {
  if (window.__executorActive) {
    return;
  }
  window.__executorActive = true;

  var ERROR_CODES = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    COMMAND_NOT_SUPPORTED: 'COMMAND_NOT_SUPPORTED',
    SELECTOR_NOT_FOUND: 'SELECTOR_NOT_FOUND',
    TIMEOUT: 'TIMEOUT',
    EXECUTION_ERROR: 'EXECUTION_ERROR'
  };

  function truncateText(value, maxLen) {
    var limit = typeof maxLen === 'number' ? maxLen : 90;
    var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  }

  function makeError(code, message, details) {
    var err = new Error(message || 'Executor error');
    err.code = code || ERROR_CODES.EXECUTION_ERROR;
    err.details = details || null;
    return err;
  }

  function asPositiveInt(value, fallback, min, max) {
    var n = Number(value);
    if (!Number.isFinite(n)) {
      return fallback;
    }
    var rounded = Math.floor(n);
    var low = typeof min === 'number' ? min : 0;
    var high = typeof max === 'number' ? max : Number.MAX_SAFE_INTEGER;
    return Math.min(high, Math.max(low, rounded));
  }

  function getStableSelector(el) {
    try {
      if (window.__getStableSelector) {
        return window.__getStableSelector(el);
      }
    } catch (_err) {}
    return null;
  }

  function postResult(payload) {
    try {
      window.postMessage(
        {
          __universalAgent: true,
          type: 'EXECUTION_RESULT',
          executionId: payload.executionId,
          success: !!payload.success,
          errorCode: payload.errorCode || null,
          error: payload.error || null,
          output: typeof payload.output === 'undefined' ? null : payload.output
        },
        '*'
      );
    } catch (err) {
      console.error('[UA executor] postResult failed', err);
    }
  }

  function setElementValue(el, value) {
    if (!el) {
      return;
    }

    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
      el.textContent = value;
      return;
    }

    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');

    if (nativeSetter && typeof nativeSetter.set === 'function') {
      nativeSetter.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function appendElementValue(el, char) {
    if (!el) {
      return;
    }

    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
      el.textContent = (el.textContent || '') + char;
      return;
    }

    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
    var current = el.value || '';

    if (nativeSetter && typeof nativeSetter.set === 'function') {
      nativeSetter.set.call(el, current + char);
    } else {
      el.value = current + char;
    }
  }

  function dispatchInput(el, init) {
    try {
      el.dispatchEvent(new InputEvent('input', init));
    } catch (_err) {
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
    }
  }

  function getNodeInfo(el, maxTextLength) {
    if (!el || !el.tagName) {
      return null;
    }
    var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      selector: getStableSelector(el),
      ariaLabel: el.getAttribute('aria-label') || null,
      name: el.getAttribute('name') || null,
      placeholder: el.getAttribute('placeholder') || null,
      text: truncateText(el.innerText || el.textContent || '', maxTextLength || 100),
      visible: !!(rect && rect.width > 0 && rect.height > 0),
      bounds: rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          }
        : null
    };
  }

  function collectPageMap(root, maxDepth, maxNodes) {
    var nodes = [];
    var queue = [{ el: root, depth: 0, path: '0' }];
    while (queue.length && nodes.length < maxNodes) {
      var current = queue.shift();
      var el = current.el;
      if (!el || !el.tagName) {
        continue;
      }

      var role = el.getAttribute('role') || null;
      var label = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || null;
      var tagUpper = el.tagName.toUpperCase();
      var interactive =
        ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'].indexOf(tagUpper) >= 0 ||
        ['button', 'link', 'textbox', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'combobox'].indexOf(
          String(role || '').toLowerCase()
        ) >= 0 ||
        el.hasAttribute('contenteditable') ||
        (el.getAttribute('tabindex') !== null && el.getAttribute('tabindex') !== '-1');

      nodes.push({
        tag: el.tagName.toLowerCase(),
        role: role,
        selector: getStableSelector(el),
        text: truncateText(el.innerText || el.textContent || '', 100),
        label: truncateText(label || '', 80),
        depth: current.depth,
        path: current.path,
        interactive: interactive
      });

      if (current.depth >= maxDepth) {
        continue;
      }

      var children = Array.from(el.children || []);
      for (var i = 0; i < children.length; i += 1) {
        queue.push({ el: children[i], depth: current.depth + 1, path: current.path + '.' + i });
        if (queue.length + nodes.length >= maxNodes * 2) {
          break;
        }
      }
    }

    return {
      nodes: nodes,
      interactive: nodes.filter(function (n) {
        return n.interactive;
      }),
      landmarks: nodes.filter(function (n) {
        return (
          ['main', 'nav', 'section', 'form', 'table', 'header', 'footer', 'aside'].indexOf(n.tag) >= 0 ||
          n.role === 'dialog'
        );
      })
    };
  }

  function handleInspectPageMap(args) {
    var mode = args && args.mode === 'zoom' ? 'zoom' : 'summary';
    var targetSelector = args && typeof args.targetSelector === 'string' ? args.targetSelector : '';
    var depth = asPositiveInt(args && args.depth, 4, 1, 7);
    var maxNodes = asPositiveInt(args && args.maxNodes, 180, 20, 500);

    var topRoot = document.documentElement || document.body;
    var target = null;
    if (mode === 'zoom' && targetSelector) {
      try {
        target = document.querySelector(targetSelector);
      } catch (_err) {
        target = null;
      }
    }
    var base = target || topRoot;
    var collect = collectPageMap(base, depth, maxNodes);
    var frameSummaries = [
      {
        mode: mode + ':top',
        frameUrl: window.location.href,
        frameTitle: truncateText(document.title || '', 120),
        totalNodes: collect.nodes.length,
        interactiveCount: collect.interactive.length,
        landmarks: collect.landmarks.slice(0, 80),
        interactive: collect.interactive.slice(0, Math.floor(maxNodes * 0.6))
      }
    ];

    var iframeEls = Array.from(document.querySelectorAll('iframe')).slice(0, 8);
    for (var i = 0; i < iframeEls.length; i += 1) {
      var frameEl = iframeEls[i];
      try {
        var frameDoc = frameEl.contentDocument;
        var frameWin = frameEl.contentWindow;
        if (!frameDoc || !frameWin) {
          continue;
        }
        var frameRoot = frameDoc.documentElement || frameDoc.body;
        if (!frameRoot) {
          continue;
        }
        var frameCollect = collectPageMap(frameRoot, depth, maxNodes);
        frameSummaries.push({
          mode: mode + ':iframe',
          frameUrl: frameWin.location ? frameWin.location.href : 'about:blank',
          frameTitle: truncateText(frameDoc.title || '', 120),
          totalNodes: frameCollect.nodes.length,
          interactiveCount: frameCollect.interactive.length,
          landmarks: frameCollect.landmarks.slice(0, 80),
          interactive: frameCollect.interactive.slice(0, Math.floor(maxNodes * 0.6))
        });
      } catch (_err) {
        frameSummaries.push({
          mode: mode + ':iframe',
          frameUrl: frameEl.src || 'cross-origin',
          frameTitle: '',
          inaccessible: true
        });
      }
    }

    return {
      mode: mode,
      url: window.location.href,
      title: truncateText(document.title || '', 140),
      focusedSelector: getStableSelector(document.activeElement),
      targetSelector: targetSelector || null,
      targetFound: !!target,
      frameSummaries: frameSummaries
    };
  }

  function handleGetActionContext(args) {
    var selector = args && typeof args.selector === 'string' ? args.selector : '';
    if (!selector) {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'selector is required for GET_ACTION_CONTEXT');
    }

    var radius = asPositiveInt(args && args.radius, 3, 1, 6);
    var maxSiblings = asPositiveInt(args && args.maxSiblings, 8, 2, 20);
    var maxChildren = asPositiveInt(args && args.maxChildren, 16, 4, 40);
    var target = null;

    try {
      target = document.querySelector(selector);
    } catch (_err) {
      target = null;
    }

    var result = {
      url: window.location.href,
      frameTitle: truncateText(document.title || '', 120),
      requestedSelector: selector,
      found: !!target,
      target: getNodeInfo(target, 100),
      ancestry: [],
      siblings: [],
      descendants: []
    };

    if (!target) {
      return result;
    }

    var current = target.parentElement;
    var depth = 0;
    while (current && depth < radius) {
      var node = getNodeInfo(current, 100);
      if (node) {
        result.ancestry.push(node);
      }
      current = current.parentElement;
      depth += 1;
    }

    var siblings = Array.from((target.parentElement && target.parentElement.children) || [])
      .filter(function (el) {
        return el !== target;
      })
      .slice(0, maxSiblings);
    for (var i = 0; i < siblings.length; i += 1) {
      var sib = getNodeInfo(siblings[i], 100);
      if (sib) {
        result.siblings.push(sib);
      }
    }

    var stack = Array.from(target.children || []).slice(0, maxChildren);
    while (stack.length && result.descendants.length < maxChildren) {
      var el = stack.shift();
      var info = getNodeInfo(el, 100);
      if (info) {
        result.descendants.push(info);
      }
      var kids = Array.from(el.children || []);
      for (var k = 0; k < kids.length; k += 1) {
        if (stack.length >= maxChildren * 2) {
          break;
        }
        stack.push(kids[k]);
      }
    }

    return result;
  }

  var executorHelpers = {
    delay: function (ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    },

    waitForElement: function (selector, timeoutMs) {
      var timeout = typeof timeoutMs === 'number' ? timeoutMs : 5000;
      return new Promise(function (resolve, reject) {
        try {
          var existing = document.querySelector(selector);
          if (existing) {
            resolve(existing);
            return;
          }

          var obs = new MutationObserver(function () {
            try {
              var found = document.querySelector(selector);
              if (found) {
                obs.disconnect();
                resolve(found);
              }
            } catch (err) {
              obs.disconnect();
              reject(err);
            }
          });

          obs.observe(document.body || document.documentElement, { subtree: true, childList: true });

          setTimeout(function () {
            obs.disconnect();
            reject(makeError(ERROR_CODES.TIMEOUT, 'Timeout waiting for selector: ' + selector, { selector: selector }));
          }, timeout);
        } catch (err) {
          reject(err);
        }
      });
    },

    getElement: function (selector) {
      return document.querySelector(selector);
    },

    click: async function (selectorOrEl) {
      var el = typeof selectorOrEl === 'string' ? await executorHelpers.waitForElement(selectorOrEl) : selectorOrEl;
      if (!el) {
        throw new Error('click: element not found - ' + selectorOrEl);
      }

      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center' });
      }
      if (typeof el.focus === 'function') {
        el.focus();
      }

      // user-event is test-focused; dispatching native DOM events is safer for live page injection.
      var PointerCtor = window.PointerEvent || MouseEvent;
      var eventSequence = [
        ['pointerover', PointerCtor],
        ['mouseover', MouseEvent],
        ['pointermove', PointerCtor],
        ['mousemove', MouseEvent],
        ['pointerdown', PointerCtor],
        ['mousedown', MouseEvent],
        ['pointerup', PointerCtor],
        ['mouseup', MouseEvent],
        ['click', MouseEvent]
      ];

      var baseInit = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 };

      for (var i = 0; i < eventSequence.length; i += 1) {
        var type = eventSequence[i][0];
        var Ctor = eventSequence[i][1];
        var isPointerEvent = type.indexOf('pointer') === 0;
        var init = isPointerEvent
          ? { ...baseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }
          : baseInit;

        el.dispatchEvent(new Ctor(type, init));
      }

      return el;
    },

    fill: async function (selectorOrEl, value) {
      var el = typeof selectorOrEl === 'string' ? await executorHelpers.waitForElement(selectorOrEl) : selectorOrEl;
      if (!el) {
        throw new Error('fill: element not found - ' + selectorOrEl);
      }

      if (typeof el.focus === 'function') {
        el.focus();
      }

      setElementValue(el, value);

      dispatchInput(el, {
        bubbles: true,
        cancelable: true,
        composed: true,
        data: String(value),
        inputType: 'insertText'
      });

      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el;
    },

    type: async function (selectorOrEl, text) {
      var el = typeof selectorOrEl === 'string' ? await executorHelpers.waitForElement(selectorOrEl) : selectorOrEl;
      if (!el) {
        throw new Error('type: element not found - ' + selectorOrEl);
      }

      if (typeof el.focus === 'function') {
        el.focus();
      }

      for (var char of String(text || '')) {
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true, composed: true })
        );
        el.dispatchEvent(
          new KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true, composed: true })
        );

        appendElementValue(el, char);

        dispatchInput(el, {
          bubbles: true,
          cancelable: true,
          composed: true,
          data: char,
          inputType: 'insertText'
        });

        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, composed: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el;
    },

    keyboard: async function (key) {
      var init = { key: key, bubbles: true, cancelable: true, composed: true };
      var activeEl = document.activeElement || document.body;
      if (!activeEl) {
        return;
      }
      activeEl.dispatchEvent(new KeyboardEvent('keydown', init));
      activeEl.dispatchEvent(new KeyboardEvent('keyup', init));
    },

    selectOptions: async function (selectorOrEl, value) {
      var el = typeof selectorOrEl === 'string' ? await executorHelpers.waitForElement(selectorOrEl) : selectorOrEl;
      if (!el) {
        throw new Error('selectOptions: element not found - ' + selectorOrEl);
      }

      if (typeof el.focus === 'function') {
        el.focus();
      }
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el;
    },

    setValue: async function (selectorOrEl, value) {
      return executorHelpers.fill(selectorOrEl, value);
    }
  };

  function validateAction(action, index) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'Action #' + index + ' must be an object');
    }
    var type = action.type;
    if (typeof type !== 'string' || !type) {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'Action #' + index + ' missing type');
    }

    var supported = ['waitForElement', 'click', 'fill', 'type', 'selectOptions', 'keyboard', 'delay', 'readText'];
    if (supported.indexOf(type) < 0) {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'Unsupported action type: ' + type);
    }

    if (['waitForElement', 'click', 'fill', 'type', 'selectOptions', 'readText'].indexOf(type) >= 0) {
      if (typeof action.selector !== 'string' || !action.selector.trim()) {
        throw makeError(ERROR_CODES.VALIDATION_ERROR, 'Action #' + index + ' requires selector');
      }
    }
    if (type === 'fill' && typeof action.value !== 'string') {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'fill action requires string value');
    }
    if (type === 'type' && typeof action.text !== 'string') {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'type action requires string text');
    }
    if (type === 'selectOptions' && typeof action.value !== 'string') {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'selectOptions action requires string value');
    }
    if (type === 'keyboard' && typeof action.key !== 'string') {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'keyboard action requires key');
    }
    if (type === 'delay' && !Number.isFinite(Number(action.ms))) {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'delay action requires numeric ms');
    }
  }

  async function runActions(args) {
    var actions = args && Array.isArray(args.actions) ? args.actions : null;
    if (!actions || actions.length < 1) {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'RUN_ACTIONS requires at least one action');
    }
    if (actions.length > 25) {
      throw makeError(ERROR_CODES.VALIDATION_ERROR, 'RUN_ACTIONS supports up to 25 actions');
    }

    var executed = [];
    for (var i = 0; i < actions.length; i += 1) {
      var action = actions[i];
      validateAction(action, i);
      var type = action.type;

      try {
        if (type === 'waitForElement') {
          await executorHelpers.waitForElement(action.selector, asPositiveInt(action.timeoutMs, 5000, 250, 20000));
        } else if (type === 'click') {
          await executorHelpers.click(action.selector);
        } else if (type === 'fill') {
          await executorHelpers.fill(action.selector, action.value);
        } else if (type === 'type') {
          await executorHelpers.type(action.selector, action.text);
        } else if (type === 'selectOptions') {
          await executorHelpers.selectOptions(action.selector, action.value);
        } else if (type === 'keyboard') {
          await executorHelpers.keyboard(action.key);
        } else if (type === 'delay') {
          await executorHelpers.delay(asPositiveInt(action.ms, 200, 0, 20000));
        } else if (type === 'readText') {
          var el = await executorHelpers.waitForElement(action.selector, asPositiveInt(action.timeoutMs, 5000, 250, 20000));
          executed.push({
            index: i,
            type: type,
            selector: action.selector,
            value: truncateText(el.innerText || el.textContent || '', 500)
          });
          continue;
        }

        executed.push({
          index: i,
          type: type,
          selector: action.selector || null
        });
      } catch (err) {
        var message = err && err.message ? err.message : String(err);
        if (message.indexOf('element not found') >= 0) {
          throw makeError(ERROR_CODES.SELECTOR_NOT_FOUND, message, { actionIndex: i, action: action });
        }
        if (err && err.code) {
          throw makeError(err.code, err.message, { actionIndex: i, action: action });
        }
        throw makeError(ERROR_CODES.EXECUTION_ERROR, message, { actionIndex: i, action: action });
      }
    }

    return {
      frameUrl: window.location.href,
      frameTitle: truncateText(document.title || '', 120),
      executed: executed
    };
  }

  async function executeCommand(message) {
    var command = message.command;
    var args = message.args && typeof message.args === 'object' ? message.args : {};

    if (command === 'INSPECT_PAGE_MAP') {
      return handleInspectPageMap(args);
    }
    if (command === 'GET_ACTION_CONTEXT') {
      return handleGetActionContext(args);
    }
    if (command === 'RUN_ACTIONS') {
      return await runActions(args);
    }
    throw makeError(ERROR_CODES.COMMAND_NOT_SUPPORTED, 'Unsupported command: ' + String(command || ''));
  }

  window.addEventListener('message', async function (event) {
    if (event.source !== window) {
      return;
    }
    if (!event.data || event.data.__universalAgent !== true) {
      return;
    }
    if (event.data.type === 'EXECUTE_CODE') {
      postResult({
        executionId: event.data.executionId,
        success: false,
        errorCode: ERROR_CODES.COMMAND_NOT_SUPPORTED,
        error: 'Legacy EXECUTE_CODE is disabled. Use EXECUTOR_COMMAND.',
        output: null
      });
      return;
    }
    if (event.data.type !== 'EXECUTOR_COMMAND') {
      return;
    }

    var executionId = event.data.executionId;

    try {
      var output = await executeCommand(event.data);
      postResult({ executionId: executionId, success: true, output: output == null ? null : output });
    } catch (err) {
      postResult({
        executionId: executionId,
        success: false,
        errorCode: err && err.code ? err.code : ERROR_CODES.EXECUTION_ERROR,
        error: err && err.message ? err.message : String(err),
        output: null
      });
    }
  });
})();
