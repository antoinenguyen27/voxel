(function () {
  if (window.__executorActive) {
    return;
  }
  window.__executorActive = true;

  function postResult(payload) {
    try {
      window.postMessage(
        {
          __universalAgent: true,
          type: 'EXECUTION_RESULT',
          executionId: payload.executionId,
          success: !!payload.success,
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
            reject(new Error('Timeout: ' + selector));
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

  window.addEventListener('message', async function (event) {
    if (event.source !== window) {
      return;
    }
    if (!event.data || event.data.__universalAgent !== true || event.data.type !== 'EXECUTE_CODE') {
      return;
    }

    var executionId = event.data.executionId;
    var code = event.data.code;

    try {
      var fn = new Function(
        '__helpers',
        'const { click, fill, type, keyboard, selectOptions, setValue, waitForElement, getElement, delay } = __helpers; return (async () => {' +
          String(code || '') +
          '\n})();'
      );
      var output = await fn(executorHelpers);
      postResult({ executionId: executionId, success: true, output: output == null ? null : output });
    } catch (err) {
      postResult({
        executionId: executionId,
        success: false,
        error: err && err.message ? err.message : String(err),
        output: null
      });
    }
  });
})();
