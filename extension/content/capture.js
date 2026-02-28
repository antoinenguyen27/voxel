(function () {
  if (window.__captureActive) {
    return;
  }
  window.__captureActive = true;

  var buffer = [];
  var flushTimer = null;
  var FLUSH_DELAY_MS = 400;
  var CAPTURE_EVENTS = ['click', 'input', 'change', 'keydown'];
  var mutationObserver = null;

  function isNthChildSelector(sel) {
    return !!sel && (sel.indexOf('nth-of-type') !== -1 || sel.indexOf('nth-child') !== -1);
  }

  function isSignificantGetUrl(url) {
    return !!url && (url.indexOf('/slides/') !== -1 || url.indexOf('/document/') !== -1 || url.indexOf('/spreadsheet/') !== -1);
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
          events: batch,
          url: window.location.href,
          timestamp: Date.now()
        },
        '*'
      );
    } catch (err) {
      console.error('[UA capture] flush failed', err);
    }
  }

  function eventHandler(event) {
    try {
      var el = event.target;
      if (!el || !el.tagName || el.tagName === 'BODY' || el.tagName === 'HTML') {
        return;
      }
      if (typeof el.closest === 'function' && el.closest('[data-universal-agent-ui]')) {
        return;
      }

      var selector = window.__getStableSelector ? window.__getStableSelector(el) : null;
      var record = {
        type: 'DOM_EVENT',
        eventType: event.type,
        tag: el.tagName.toLowerCase(),
        selector: selector,
        ariaLabel: typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null,
        role: typeof el.getAttribute === 'function' ? el.getAttribute('role') : null,
        value:
          event.type === 'input' || event.type === 'change'
            ? (typeof el.value !== 'undefined' ? el.value : (el.textContent ? el.textContent.slice(0, 200) : null))
            : null,
        innerText: el.innerText ? el.innerText.slice(0, 80) : null,
        timestamp: Date.now(),
        confidence: isNthChildSelector(selector) ? 'low' : 'high'
      };

      buffer.push(record);
      scheduleFlush();
    } catch (err) {
      console.error('[UA capture] eventHandler failed', err);
    }
  }

  function startMutationObserver() {
    try {
      if (!document.body) {
        return;
      }
      mutationObserver = new MutationObserver(function (mutations) {
        try {
          var meaningful = mutations.filter(function (m) {
            if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
              return Array.prototype.some.call([].concat(Array.from(m.addedNodes), Array.from(m.removedNodes)), function (n) {
                return n && n.nodeType === 1 && n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE';
              });
            }
            if (m.type === 'attributes') {
              var target = m.target;
              return !!(target && target.tagName && ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].indexOf(target.tagName) !== -1);
            }
            return false;
          });

          if (!meaningful.length) {
            return;
          }

          buffer.push({
            type: 'DOM_MUTATION',
            count: meaningful.length,
            summary: meaningful.slice(0, 3).map(function (m) {
              return {
                kind: m.type,
                target: window.__getStableSelector ? (window.__getStableSelector(m.target) || m.target.tagName) : m.target.tagName,
                added: m.addedNodes.length,
                removed: m.removedNodes.length
              };
            }),
            timestamp: Date.now()
          });

          scheduleFlush();
        } catch (err) {
          console.error('[UA capture] mutation callback failed', err);
        }
      });

      mutationObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['value', 'aria-label', 'disabled', 'checked', 'selected'],
        characterData: false
      });
    } catch (err) {
      console.error('[UA capture] startMutationObserver failed', err);
    }
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
          var result = await origFetch.apply(this, args);
          try {
            result.clone();
            var req = args[0];
            var init = args[1] || {};
            var url = typeof req === 'string' ? req : req && req.url ? req.url : '';
            var method = init.method || (req && req.method) || 'GET';

            if (method !== 'GET' || isSignificantGetUrl(url)) {
              var bodyText = null;
              if (init.body) {
                bodyText = typeof init.body === 'string' ? init.body.slice(0, 500) : '[binary]';
              }

              buffer.push({
                type: 'NETWORK_FETCH',
                url: url ? url.split('?')[0] : null,
                method: String(method).toUpperCase(),
                body: bodyText,
                status: result.status,
                timestamp: Date.now()
              });
              scheduleFlush();
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
              if (method === 'GET' && !isSignificantGetUrl(this.__ua_url || '')) {
                return;
              }
              buffer.push({
                type: 'NETWORK_XHR',
                url: this.__ua_url ? String(this.__ua_url).split('?')[0] : null,
                method: method,
                body: typeof body === 'string' ? body.slice(0, 500) : null,
                status: this.status,
                timestamp: Date.now()
              });
              scheduleFlush();
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

  CAPTURE_EVENTS.forEach(function (evt) {
    try {
      document.addEventListener(evt, eventHandler, { capture: true, passive: true });
    } catch (err) {
      console.error('[UA capture] addEventListener failed', evt, err);
    }
  });

  startMutationObserver();
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
      CAPTURE_EVENTS.forEach(function (evt) {
        try {
          document.removeEventListener(evt, eventHandler, true);
        } catch (_err) {}
      });
      if (mutationObserver) {
        mutationObserver.disconnect();
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      window.__captureActive = false;
    } catch (err) {
      console.error('[UA capture] stop failed', err);
    }
  };
})();
