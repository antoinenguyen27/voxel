(function () {
  if (window.__captureActive) {
    return;
  }
  window.__captureActive = true;

  var buffer = [];
  var flushTimer = null;
  var FLUSH_DELAY_MS = 400;
  var inputBuffers = new WeakMap();
  var trackedInputElements = new Set();

  function isTextField(el) {
    if (!el) {
      return false;
    }
    var tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      return true;
    }
    if (typeof el.getAttribute === 'function' && el.getAttribute('contenteditable') === 'true') {
      return true;
    }
    if (typeof el.getAttribute === 'function' && el.getAttribute('role') === 'textbox') {
      return true;
    }
    return false;
  }

  function scheduleFlush() {
    try {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    } catch (err) {
      console.error('[UA capture] scheduleFlush failed', err);
    }
  }

  function recordAction(action) {
    try {
      if (!action || typeof action !== 'object') {
        return;
      }
      buffer.push({
        ...action,
        timestamp: Date.now()
      });
      scheduleFlush();
    } catch (err) {
      console.error('[UA capture] recordAction failed', err);
    }
  }

  function flush() {
    try {
      if (!buffer.length) {
        return;
      }
      var batch = buffer.splice(0, buffer.length);
      window.postMessage(
        {
          __universalAgent: true,
          type: 'ACTION_BATCH',
          actions: batch,
          url: window.location.href,
          timestamp: Date.now()
        },
        '*'
      );
    } catch (err) {
      console.error('[UA capture] flush failed', err);
    }
  }

  function onFocus(event) {
    try {
      var el = event.target;
      if (!isTextField(el)) {
        return;
      }
      if (!inputBuffers.has(el)) {
        inputBuffers.set(el, {
          initialValue: el.value || el.textContent || '',
          timer: null
        });
        trackedInputElements.add(el);
      }
    } catch (err) {
      console.error('[UA capture] onFocus failed', err);
    }
  }

  function onInput(event) {
    try {
      var el = event.target;
      if (!isTextField(el)) {
        return;
      }

      var state = inputBuffers.get(el) || {
        initialValue: '',
        timer: null
      };

      if (state.timer) {
        clearTimeout(state.timer);
      }

      state.timer = setTimeout(function () {
        try {
          var finalValue = el.value || el.innerText || '';
          if (finalValue !== state.initialValue) {
            recordAction({
              action: 'fill',
              selector: window.__getStableSelector ? window.__getStableSelector(el) : null,
              ariaLabel: typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null,
              value: finalValue
            });
          }
        } catch (err) {
          console.error('[UA capture] input settle failed', err);
        } finally {
          inputBuffers.delete(el);
          trackedInputElements.delete(el);
        }
      }, 600);

      inputBuffers.set(el, state);
      trackedInputElements.add(el);
    } catch (err) {
      console.error('[UA capture] onInput failed', err);
    }
  }

  function onClick(event) {
    try {
      var el = event.target;
      if (!el || !el.tagName || el.tagName === 'BODY' || el.tagName === 'HTML') {
        return;
      }
      if (typeof el.closest === 'function' && el.closest('[data-universal-agent-ui]')) {
        return;
      }

      recordAction({
        action: 'click',
        selector: window.__getStableSelector ? window.__getStableSelector(el) : null,
        ariaLabel: typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null,
        role: typeof el.getAttribute === 'function' ? el.getAttribute('role') : null,
        tag: el.tagName.toLowerCase(),
        innerText: el.innerText ? el.innerText.trim().slice(0, 60) : null
      });
    } catch (err) {
      console.error('[UA capture] onClick failed', err);
    }
  }

  function onChange(event) {
    try {
      var el = event.target;
      if (!el || el.tagName !== 'SELECT') {
        return;
      }

      recordAction({
        action: 'selectOptions',
        selector: window.__getStableSelector ? window.__getStableSelector(el) : null,
        ariaLabel: typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null,
        value: el.value
      });
    } catch (err) {
      console.error('[UA capture] onChange failed', err);
    }
  }

  function onKeydown(event) {
    try {
      var el = event.target;
      var key = event.key || '';
      // Capture all keydown events so IME/editor flows (including key="Process")
      // are observable in diagnostics and downstream action selection.
      if (!key && !event.code) {
        return;
      }

      recordAction({
        action: 'keyboard',
        eventType: 'keydown',
        key: key,
        code: event.code || null,
        ctrlKey: !!event.ctrlKey,
        metaKey: !!event.metaKey,
        altKey: !!event.altKey,
        shiftKey: !!event.shiftKey,
        selector: window.__getStableSelector ? window.__getStableSelector(el) : null
      });
    } catch (err) {
      console.error('[UA capture] onKeydown failed', err);
    }
  }

  function onComposition(event) {
    try {
      var el = event.target;
      if (!el || !el.tagName || el.tagName === 'BODY' || el.tagName === 'HTML') {
        return;
      }

      var eventType = event.type || 'compositionupdate';
      var text = event && typeof event.data === 'string' ? event.data : '';
      recordAction({
        action: 'keyboard',
        eventType: eventType,
        key: text || eventType,
        code: null,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        selector: window.__getStableSelector ? window.__getStableSelector(el) : null
      });
    } catch (err) {
      console.error('[UA capture] onComposition failed', err);
    }
  }

  function methodIsMutating(method) {
    var m = String(method || 'GET').toUpperCase();
    return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
  }

  function patchNetwork() {
    if (window.__uaNetworkPatched) {
      return;
    }
    window.__uaNetworkPatched = true;

    try {
      var origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = async function () {
          var args = Array.prototype.slice.call(arguments);
          var req = args[0];
          var init = args[1] || {};
          var url = typeof req === 'string' ? req : req && req.url ? req.url : '';
          var method = init.method || (req && req.method) || 'GET';
          var bodyText = null;

          if (init.body) {
            bodyText = typeof init.body === 'string' ? init.body.slice(0, 500) : '[binary]';
          }

          var result = await origFetch.apply(this, args);

          try {
            if (methodIsMutating(method)) {
              recordAction({
                action: 'network',
                method: String(method).toUpperCase(),
                url: url ? String(url).split('?')[0] : null,
                body: bodyText,
                status: result.status
              });
            }
          } catch (_err) {
            // Never break page fetch behavior.
          }

          return result;
        };
      }
    } catch (err) {
      console.error('[UA capture] fetch patch failed', err);
    }

    try {
      if (!XMLHttpRequest || !XMLHttpRequest.prototype) {
        return;
      }

      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          this.__ua_method = method;
          this.__ua_url = url;
        } catch (_err) {}
        return origOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function (body) {
        try {
          this.addEventListener('load', function () {
            try {
              var method = (this.__ua_method || 'GET').toUpperCase();
              if (!methodIsMutating(method)) {
                return;
              }

              recordAction({
                action: 'network',
                method: method,
                url: this.__ua_url ? String(this.__ua_url).split('?')[0] : null,
                body: typeof body === 'string' ? body.slice(0, 500) : null,
                status: this.status
              });
            } catch (_err) {
              // Keep XHR stable even if capture fails.
            }
          });
        } catch (_err) {}

        return origSend.apply(this, arguments);
      };
    } catch (err) {
      console.error('[UA capture] XHR patch failed', err);
    }
  }

  document.addEventListener('focus', onFocus, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('compositionstart', onComposition, true);
  document.addEventListener('compositionupdate', onComposition, true);
  document.addEventListener('compositionend', onComposition, true);

  patchNetwork();

  window.addEventListener('message', function (event) {
    try {
      if (event.source !== window || !event.data || event.data.__universalAgent !== true) {
        return;
      }
      if (event.data.type === 'STOP_CAPTURE' && typeof window.__stopCapture === 'function') {
        window.__stopCapture();
      }
    } catch (_err) {}
  });

  window.__stopCapture = function () {
    try {
      document.removeEventListener('focus', onFocus, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('compositionstart', onComposition, true);
      document.removeEventListener('compositionupdate', onComposition, true);
      document.removeEventListener('compositionend', onComposition, true);

      trackedInputElements.forEach(function (el) {
        var state = inputBuffers.get(el);
        if (state && state.timer) {
          clearTimeout(state.timer);
        }
      });
      trackedInputElements.clear();

      flush();
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      window.__captureActive = false;
    } catch (err) {
      console.error('[UA capture] stop failed', err);
    }
  };
})();
