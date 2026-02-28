(function () {
  var state = {
    mode: 'idle',
    activeTabId: null,
    demoRecorder: null,
    demoStream: null,
    demoChunks: [],
    isDemoTranscribing: false,
    workRecorder: null,
    workStream: null,
    workChunks: [],
    isListening: false,
    heartbeatTimer: null
  };

  var ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

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

  async function sendRuntimeMessage(message) {
    try {
      return await new Promise(function (resolve, reject) {
        chrome.runtime.sendMessage(message, function (response) {
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

  async function getActiveTabId() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length || typeof tabs[0].id !== 'number') {
        throw new Error('No active tab found.');
      }
      return tabs[0].id;
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

  async function ensureMicPermission() {
    var stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } finally {
      if (stream) {
        stream.getTracks().forEach(function (track) {
          try {
            track.stop();
          } catch (_err) {}
        });
      }
    }
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

      var formData = new FormData();
      formData.append('file', audioBlob, 'audio.webm');
      formData.append('model', 'voxtral-mini-transcribe-v2');

      var response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey },
        body: formData
      });

      if (!response.ok) {
        var errorText = await response.text().catch(function () {
          return '';
        });
        throw new Error('Voxtral transcription failed (' + response.status + '): ' + errorText.slice(0, 300));
      }

      var data = await response.json();
      return (data && data.text ? String(data.text) : '').trim();
    } catch (err) {
      throw err;
    }
  }

  async function startDemoTranscription() {
    try {
      state.demoStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      state.demoChunks = [];
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
            els.transcriptText.textContent = transcript;
            appendLog('Demo transcript: ' + transcript);
            try {
              await sendRuntimeMessage({
                type: 'VOICE_SEGMENT',
                transcript: transcript,
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
    state.isDemoTranscribing = false;
  }

  async function captureWorkInstruction() {
    try {
      state.isListening = true;
      updateButtons();
      setStatus('Listening...', 'busy');

      state.workChunks = [];
      state.workStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
            els.transcriptText.textContent = transcript;
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
      var activeTab = await getActiveTab();
      if (!isInjectableUrl(activeTab.url || '')) {
        throw new Error('Cannot inject into this tab');
      }

      await ensureMicPermission();

      state.activeTabId = activeTab.id;
      var response = await sendRuntimeMessage({ type: 'START_DEMO', tabId: state.activeTabId });
      if (!response.ok) {
        throw new Error(response.error || 'Failed to start demo mode.');
      }
      runtimeStarted = true;

      state.mode = 'demo';
      updateButtons();
      setStatus('Demo recording...', 'busy');
      startHeartbeat();
      await startDemoTranscription();
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
      var message = normalizeUserFacingError(err);
      setStatus(message, 'error');
      appendLog('startDemoMode failed: ' + message);
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
      var response = await sendRuntimeMessage({ type: 'START_WORK', tabId: state.activeTabId });
      if (!response.ok) {
        throw new Error(response.error || 'Failed to start work mode.');
      }

      state.mode = 'work';
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
      setStatus(err.message, 'error');
      appendLog('runWorkInstruction failed: ' + err.message);
    }
  }

  chrome.runtime.onMessage.addListener(function (message) {
    try {
      if (!message || message.type !== 'STATUS_UPDATE') {
        return;
      }
      var level = message.level === 'error' ? 'error' : message.level === 'success' ? 'ready' : 'busy';
      setStatus(message.message || 'Update', level);
      appendLog(message.message || 'Update');
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
