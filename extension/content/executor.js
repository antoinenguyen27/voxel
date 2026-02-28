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
      var el = typeof selectorOrEl === 'string' ? document.querySelector(selectorOrEl) : selectorOrEl;
      if (!el) {
        throw new Error('Element not found: ' + selectorOrEl);
      }
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return el;
    },

    setValue: function (selectorOrEl, value) {
      var el = typeof selectorOrEl === 'string' ? document.querySelector(selectorOrEl) : selectorOrEl;
      if (!el) {
        throw new Error('Element not found: ' + selectorOrEl);
      }

      el.focus();

      var prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value');

      if (nativeSetter && typeof nativeSetter.set === 'function') {
        nativeSetter.set.call(el, value);
      } else {
        el.value = value;
      }

      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: String(value) }));
      } catch (_err) {
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return el;
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
        'const { click, setValue, waitForElement, getElement, delay } = __helpers; return (async () => {' +
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
