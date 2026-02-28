(function () {
  if (window.__uaBridgeActive) {
    return;
  }
  window.__uaBridgeActive = true;

  function postToMain(payload) {
    try {
      window.postMessage(payload, '*');
    } catch (err) {
      console.error('[UA bridge] postToMain failed', err);
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) {
      return;
    }
    var data = event.data;
    if (!data || data.__universalAgent !== true) {
      return;
    }

    try {
      chrome.runtime.sendMessage(data, function () {
        var runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          postToMain({
            __universalAgent: true,
            type: 'BRIDGE_ERROR',
            sourceType: data.type || 'unknown',
            error: runtimeError.message
          });
        }
      });
    } catch (err) {
      postToMain({
        __universalAgent: true,
        type: 'BRIDGE_ERROR',
        sourceType: data.type || 'unknown',
        error: err && err.message ? err.message : String(err)
      });
    }
  });

  chrome.runtime.onMessage.addListener(function (message) {
    try {
      if (!message || (message.type !== 'EXECUTE_CODE' && message.type !== 'PING' && message.type !== 'STOP_CAPTURE')) {
        return;
      }

      postToMain({
        __universalAgent: true,
        type: message.type,
        code: message.code,
        executionId: message.executionId
      });
    } catch (err) {
      console.error('[UA bridge] runtime message relay failed', err);
    }
  });
})();
