(function () {
  var state = {
    mode: 'idle',
    activeTabId: null,
    demoRecorder: null,
    demoStream: null,
    demoChunks: [],
    demoTranscript: '',
    isDemoTranscribing: false,
    workRecorder: null,
    workStream: null,
    workChunks: [],
    workTranscript: '',
    isListening: false,
    heartbeatTimer: null
  };

  var ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
  var VOXTRAL_BATCH_MODELS = ['voxtral-mini-latest', 'voxtral-mini-transcribe-v2'];

  var els = {
    startDemoBtn: document.getElementById('startDemoBtn'),
    stopDemoBtn: document.getElementById('stopDemoBtn'),
    startWorkBtn: document.getElementById('startWorkBtn'),
    stopWorkBtn: document.getElementById('stopWorkBtn'),
    micBtn: document.getElementById('micBtn'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    transcriptText: document.getElementById('transcriptText'),
    logText: document.getElementById('logText')
  };

  function appendLog(line) {
    var next = '[' + new Date().toLocaleTimeString() + '] ' + line;
    els.logText.textContent = (els.logText.textContent ? els.logText.textContent + '\n' : '') + next;
    els.logText.scrollTop = els.logText.scrollHeight;
  }

  function setStatus(text, level) {
    els.statusText.textContent = text;
    els.statusDot.className = 'dot ' + (level || 'idle');
  }

  async function getStoredApiKey(service) {
    try {
      var key = service === 'elevenlabs' ? 'elevenlabs_api_key' : 'mistral_api_key';
      var result = await chrome.storage.local.get(key);
      return result[key] || '';
    } catch (err) {
      appendLog('Failed to read API key: ' + (err && err.message ? err.message : String(err)));
      return '';
    }
  }

  async function sendRuntimeMessage(message, timeoutMs) {
    try {
      return await new Promise(function (resolve, reject) {
        var settled = false;
        var timeout = typeof timeoutMs === 'number' ? timeoutMs : 12000;
        var timer = setTimeout(function () {
          if (settled) {
            return;
          }
          settled = true;
          reject(new Error('Service worker response timed out.'));
        }, timeout);

        chrome.runtime.sendMessage(message, function (response) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          var runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(response || {});
        });
      });
    } catch (err) {
      throw err;
    }
  }

  async function getActiveTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length || typeof tabs[0].id !== 'number') {
      throw new Error('No active tab found.');
    }
    return tabs[0];
  }

  function isInjectableUrl(url) {
    if (!url || typeof url !== 'string') {
      return false;
    }
    return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://');
  }

  function normalizeUserFacingError(err) {
    var message = err && err.message ? String(err.message) : String(err || 'Unknown error');
    var name = err && err.name ? String(err.name) : '';
    if (
      name === 'NotAllowedError' ||
      name === 'SecurityError' ||
      message.toLowerCase().includes('permission dismissed') ||
      message.toLowerCase().includes('permission denied') ||
      message.toLowerCase().includes('notallowederror')
    ) {
      return 'Microphone access denied or blocked. If no prompt appears, re-enable mic for this extension and retry.';
    }
    if (name === 'NotFoundError') {
      return 'No microphone device found. Check your audio input device.';
    }
    if (name === 'NotReadableError') {
      return 'Microphone is in use by another app or unavailable.';
    }
    if (name === 'OverconstrainedError') {
      return 'Microphone constraints are unsupported on this device.';
    }
    if (message.includes('Cannot inject into this tab')) {
      return 'This tab is not injectable. Use a normal website tab (https://...).';
    }
    return message;
  }

  function describeError(err) {
    if (!err) {
      return 'Unknown error';
    }
    var name = err.name ? String(err.name) : 'Error';
    var message = err.message ? String(err.message) : String(err);
    return name + ': ' + message;
  }

  async function getMicrophonePermissionState() {
    try {
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
        return 'unknown';
      }
      var status = await navigator.permissions.query({ name: 'microphone' });
      return status && status.state ? String(status.state) : 'unknown';
    } catch (_err) {
      return 'unknown';
    }
  }

  function normalizeMicError(err, permissionState) {
    var raw = describeError(err).toLowerCase();
    if (permissionState === 'denied') {
      return 'Microphone is blocked for this extension. Re-enable microphone access and retry.';
    }
    if (raw.indexOf('permission dismissed') !== -1) {
      return 'Microphone prompt was dismissed. Click Start Demo again and choose Allow.';
    }
    return normalizeUserFacingError(err);
  }

  async function getUserMediaWithTimeout(constraints, timeoutMs) {
    var timeout = typeof timeoutMs === 'number' ? timeoutMs : 12000;
    return await Promise.race([
      navigator.mediaDevices.getUserMedia(constraints),
      new Promise(function (_resolve, reject) {
        setTimeout(function () {
          reject(new Error('Microphone request timed out.'));
        }, timeout);
      })
    ]);
  }

  function updateButtons() {
    var inDemo = state.mode === 'demo';
    var inWork = state.mode === 'work';

    els.startDemoBtn.disabled = inDemo || inWork;
    els.stopDemoBtn.disabled = !inDemo;
    els.startWorkBtn.disabled = inWork || inDemo;
    els.stopWorkBtn.disabled = !inWork;
    els.micBtn.disabled = !inWork;
    els.micBtn.textContent = state.isListening ? 'Stop Listening' : 'Hold-to-Talk';
  }

  function startHeartbeat() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
    }
    state.heartbeatTimer = setInterval(function () {
      sendRuntimeMessage({ type: 'PING' }).catch(function (err) {
        appendLog('Heartbeat failed: ' + err.message);
      });
    }, 15000);
  }

  function appendTranscript(existing, chunk) {
    var left = String(existing || '').trim();
    var right = String(chunk || '').trim();
    if (!right) {
      return left;
    }
    if (!left) {
      return right;
    }
    return left + '\n' + right;
  }

  function stopHeartbeat() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  async function transcribeWithVoxtral(audioBlob) {
    try {
      var apiKey = await getStoredApiKey('mistral');
      if (!apiKey) {
        throw new Error('Missing Mistral API key. Set it in options.');
      }

      var lastError = '';
      for (var i = 0; i < VOXTRAL_BATCH_MODELS.length; i += 1) {
        var model = VOXTRAL_BATCH_MODELS[i];
        var formData = new FormData();
        formData.append('file', audioBlob, 'audio.webm');
        formData.append('model', model);
        appendLog('Transcription attempt with model: ' + model);

        var response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKey },
          body: formData
        });

        if (response.ok) {
          var data = await response.json();
          return (data && data.text ? String(data.text) : '').trim();
        }

        var errorText = await response.text().catch(function () {
          return '';
        });
        lastError = 'Voxtral transcription failed (' + response.status + '): ' + errorText.slice(0, 300);

        var normalized = (errorText || '').toLowerCase();
        var modelInvalid =
          response.status === 400 &&
          (normalized.indexOf('invalid model') !== -1 || normalized.indexOf('\"code\":\"1500\"') !== -1);

        if (modelInvalid && i < VOXTRAL_BATCH_MODELS.length - 1) {
          appendLog('Model rejected by API, trying fallback model...');
          continue;
        }

        throw new Error(lastError);
      }

      throw new Error(lastError || 'Voxtral transcription failed for all configured models.');
    } catch (err) {
      throw err;
    }
  }

  async function startDemoTranscription() {
    try {
      appendLog(
        'Requesting microphone. userActivation.isActive=' +
          (!!(navigator.userActivation && navigator.userActivation.isActive))
      );
      state.demoStream = await getUserMediaWithTimeout({ audio: true }, 12000);
      appendLog('Microphone stream acquired.');

      state.demoChunks = [];
      state.demoTranscript = '';
      state.demoRecorder = new MediaRecorder(state.demoStream, { mimeType: 'audio/webm' });

      state.demoRecorder.ondataavailable = function (event) {
        try {
          if (event.data && event.data.size > 0) {
            state.demoChunks.push(event.data);
          }
        } catch (err) {
          appendLog('Demo ondataavailable error: ' + err.message);
        }
      };

      state.demoRecorder.onstop = async function () {
        try {
          if (!state.demoChunks.length) {
            return;
          }
          var blob = new Blob(state.demoChunks, { type: 'audio/webm' });
          state.demoChunks = [];
          if (state.mode !== 'demo') {
            return;
          }
          if (state.isDemoTranscribing) {
            return;
          }

          state.isDemoTranscribing = true;
          var transcript = await transcribeWithVoxtral(blob);
          if (transcript) {
            state.demoTranscript = appendTranscript(state.demoTranscript, transcript);
            els.transcriptText.textContent = state.demoTranscript;
            appendLog('Demo transcript: ' + transcript);
            try {
              await sendRuntimeMessage({
                type: 'VOICE_SEGMENT',
                transcript: transcript,
                fullTranscript: state.demoTranscript,
                segmentEnd: Date.now()
              });
            } catch (err) {
              appendLog('VOICE_SEGMENT failed: ' + err.message);
              setStatus(err.message, 'error');
            }
          }
        } catch (err) {
          appendLog('Demo transcription failed: ' + err.message);
          setStatus(err.message, 'error');
        } finally {
          state.isDemoTranscribing = false;
          if (state.mode === 'demo' && state.demoRecorder && state.demoRecorder.state === 'inactive') {
            try {
              state.demoRecorder.start();
              setTimeout(function () {
                if (state.mode === 'demo' && state.demoRecorder && state.demoRecorder.state === 'recording') {
                  state.demoRecorder.stop();
                }
              }, 4500);
            } catch (err) {
              appendLog('Failed to restart demo recorder: ' + err.message);
            }
          }
        }
      };

      state.demoRecorder.start();
      setTimeout(function () {
        if (state.mode === 'demo' && state.demoRecorder && state.demoRecorder.state === 'recording') {
          state.demoRecorder.stop();
        }
      }, 4500);
    } catch (err) {
      appendLog('startDemoTranscription failed: ' + err.message);
      setStatus(err.message, 'error');
      throw err;
    }
  }

  function stopDemoTranscription() {
    try {
      if (state.demoRecorder && state.demoRecorder.state !== 'inactive') {
        state.demoRecorder.stop();
      }
    } catch (err) {
      appendLog('stopDemoTranscription recorder error: ' + err.message);
    }

    try {
      if (state.demoStream) {
        state.demoStream.getTracks().forEach(function (track) {
          try {
            track.stop();
          } catch (_err) {}
        });
      }
    } catch (err) {
      appendLog('stopDemoTranscription stream error: ' + err.message);
    }

    state.demoRecorder = null;
    state.demoStream = null;
    state.demoChunks = [];
    state.demoTranscript = '';
    state.isDemoTranscribing = false;
  }

  async function captureWorkInstruction() {
    try {
      state.isListening = true;
      updateButtons();
      setStatus('Listening...', 'busy');

      state.workChunks = [];
      state.workTranscript = '';
      state.workStream = await getUserMediaWithTimeout({ audio: true }, 12000);
      state.workRecorder = new MediaRecorder(state.workStream, { mimeType: 'audio/webm' });

      state.workRecorder.ondataavailable = function (event) {
        try {
          if (event.data && event.data.size > 0) {
            state.workChunks.push(event.data);
          }
        } catch (err) {
          appendLog('Work ondataavailable error: ' + err.message);
        }
      };

      state.workRecorder.start();
    } catch (err) {
      state.isListening = false;
      updateButtons();
      setStatus(err.message, 'error');
      throw err;
    }
  }

  async function stopWorkInstructionCaptureAndTranscribe() {
    return new Promise(function (resolve, reject) {
      try {
        if (!state.workRecorder) {
          resolve('');
          return;
        }

        state.workRecorder.onstop = async function () {
          try {
            if (state.workStream) {
              state.workStream.getTracks().forEach(function (track) {
                try {
                  track.stop();
                } catch (_err) {}
              });
            }
            state.workStream = null;

            var blob = new Blob(state.workChunks, { type: 'audio/webm' });
            state.workChunks = [];
            var transcript = await transcribeWithVoxtral(blob);
            state.workTranscript = appendTranscript(state.workTranscript, transcript);
            els.transcriptText.textContent = state.workTranscript;
            resolve(transcript);
          } catch (err) {
            reject(err);
          } finally {
            state.isListening = false;
            updateButtons();
          }
        };

        if (state.workRecorder.state !== 'inactive') {
          state.workRecorder.stop();
        } else {
          state.isListening = false;
          updateButtons();
          resolve('');
        }
      } catch (err) {
        state.isListening = false;
        updateButtons();
        reject(err);
      }
    });
  }

  async function speakResponse(text) {
    try {
      var apiKey = await getStoredApiKey('elevenlabs');
      if (!apiKey) {
        throw new Error('Missing ElevenLabs API key. Set it in options.');
      }

      var response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + ELEVENLABS_VOICE_ID + '/stream', {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      });

      if (!response.ok) {
        var body = await response.text().catch(function () {
          return '';
        });
        throw new Error('ElevenLabs TTS failed (' + response.status + '): ' + body.slice(0, 250));
      }

      var audioBlob = await response.blob();
      var audioUrl = URL.createObjectURL(audioBlob);
      var audio = new Audio(audioUrl);

      return await new Promise(function (resolve) {
        audio.onended = function () {
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        audio.onerror = function () {
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        audio.play().catch(function () {
          URL.revokeObjectURL(audioUrl);
          resolve();
        });
      });
    } catch (err) {
      throw err;
    }
  }

  async function startDemoMode() {
    var runtimeStarted = false;
    try {
      setStatus('Starting demo...', 'busy');
      appendLog('Checking active tab...');

      var activeTab = await getActiveTab();
      if (!isInjectableUrl(activeTab.url || '')) {
        throw new Error('Cannot inject into this tab');
      }

      appendLog('Sending START_DEMO...');
      state.activeTabId = activeTab.id;
      var response = await sendRuntimeMessage({ type: 'START_DEMO', tabId: state.activeTabId }, 35000);
      appendLog('START_DEMO response received.');
      if (!response.ok) {
        throw new Error(response.error || 'Failed to start demo mode.');
      }
      runtimeStarted = true;

      state.mode = 'demo';
      state.demoTranscript = '';
      els.transcriptText.textContent = '';
      updateButtons();
      setStatus('Demo recording...', 'busy');
      startHeartbeat();
      appendLog('Starting microphone capture...');
      await startDemoTranscription();
      var micStateBefore = await getMicrophonePermissionState();
      appendLog('Microphone permission state before request: ' + micStateBefore);
      appendLog('Demo mode active.');
    } catch (err) {
      if (runtimeStarted) {
        try {
          await sendRuntimeMessage({ type: 'STOP_DEMO' });
        } catch (_err) {}
      }
      stopDemoTranscription();
      state.mode = 'idle';
      state.activeTabId = null;
      updateButtons();
      stopHeartbeat();
      var permissionState = await getMicrophonePermissionState();
      var message = normalizeMicError(err, permissionState);
      setStatus(message, 'error');
      appendLog('startDemoMode failed: ' + message);
      appendLog('Microphone permission state after failure: ' + permissionState);
      appendLog('startDemoMode raw error: ' + describeError(err));
    }
  }

  async function stopDemoMode() {
    try {
      stopDemoTranscription();
      await sendRuntimeMessage({ type: 'STOP_DEMO' });
      state.mode = 'idle';
      updateButtons();
      setStatus('Idle', 'idle');
      stopHeartbeat();
      appendLog('Demo mode stopped.');
    } catch (err) {
      setStatus(err.message, 'error');
      appendLog('stopDemoMode failed: ' + err.message);
    }
  }

  async function startWorkMode() {
    try {
      var activeTab = await getActiveTab();
      if (!isInjectableUrl(activeTab.url || '')) {
        throw new Error('Cannot inject into this tab');
      }

      state.activeTabId = activeTab.id;
      var response = await sendRuntimeMessage({ type: 'START_WORK', tabId: state.activeTabId }, 35000);
      appendLog('START_WORK response received.');
      if (!response.ok) {
        throw new Error(response.error || 'Failed to start work mode.');
      }

      state.mode = 'work';
      state.workTranscript = '';
      els.transcriptText.textContent = '';
      updateButtons();
      setStatus('Ready', 'ready');
      startHeartbeat();
      appendLog('Work mode active.');
    } catch (err) {
      var message = normalizeUserFacingError(err);
      setStatus(message, 'error');
      appendLog('startWorkMode failed: ' + message);
      appendLog('startWorkMode raw error: ' + describeError(err));
    }
  }

  async function stopWorkMode() {
    try {
      if (state.isListening) {
        await stopWorkInstructionCaptureAndTranscribe().catch(function () {
          return '';
        });
      }
      await sendRuntimeMessage({ type: 'STOP_WORK' });
      state.mode = 'idle';
      state.activeTabId = null;
      state.isListening = false;
      state.workTranscript = '';
      updateButtons();
      setStatus('Idle', 'idle');
      stopHeartbeat();
      appendLog('Work mode stopped.');
    } catch (err) {
      setStatus(err.message, 'error');
      appendLog('stopWorkMode failed: ' + err.message);
    }
  }

  async function runWorkInstruction() {
    try {
      if (state.mode !== 'work') {
        return;
      }

      if (!state.isListening) {
        await captureWorkInstruction();
        appendLog('Listening started. Press again to stop.');
        return;
      }

      var transcript = await stopWorkInstructionCaptureAndTranscribe();
      if (!String(transcript || '').trim()) {
        setStatus('No speech detected.', 'ready');
        appendLog('No transcript captured.');
        return;
      }

      setStatus('Thinking...', 'busy');

      var result = await sendRuntimeMessage({
        type: 'WORK_INSTRUCTION',
        transcript: transcript,
        tabId: state.activeTabId
      });

      if (!result.ok) {
        throw new Error(result.error || 'Agent execution failed.');
      }

      var spokenResponse = result.response || 'Done.';
      appendLog('Agent: ' + spokenResponse);

      setStatus('Speaking...', 'busy');
      await speakResponse(spokenResponse);

      // Explicitly end loop here. Mic remains off until user presses again.
      setStatus('Ready', 'ready');
    } catch (err) {
      state.isListening = false;
      updateButtons();
      var permissionState = await getMicrophonePermissionState();
      var message = normalizeMicError(err, permissionState);
      setStatus(message, 'error');
      appendLog('runWorkInstruction failed: ' + message);
      appendLog('Microphone permission state after work failure: ' + permissionState);
      appendLog('runWorkInstruction raw error: ' + describeError(err));
    }
  }

  chrome.runtime.onMessage.addListener(function (message) {
    try {
      if (!message) {
        return;
      }
      if (message.type === 'STATUS_UPDATE') {
        var level = message.level === 'error' ? 'error' : message.level === 'success' ? 'ready' : 'busy';
        setStatus(message.message || 'Update', level);
        appendLog(message.message || 'Update');
        return;
      }
    } catch (err) {
      appendLog('Status listener failed: ' + err.message);
    }
  });

  els.startDemoBtn.addEventListener('click', function () {
    startDemoMode().catch(function (err) {
      setStatus(err.message, 'error');
    });
  });

  els.stopDemoBtn.addEventListener('click', function () {
    stopDemoMode().catch(function (err) {
      setStatus(err.message, 'error');
    });
  });

  els.startWorkBtn.addEventListener('click', function () {
    startWorkMode().catch(function (err) {
      setStatus(err.message, 'error');
    });
  });

  els.stopWorkBtn.addEventListener('click', function () {
    stopWorkMode().catch(function (err) {
      setStatus(err.message, 'error');
    });
  });

  els.micBtn.addEventListener('click', function () {
    runWorkInstruction().catch(function (err) {
      setStatus(err.message, 'error');
    });
  });

  updateButtons();
  setStatus('Idle', 'idle');
})();
