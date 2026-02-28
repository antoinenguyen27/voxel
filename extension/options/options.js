(function () {
  var mistralInput = document.getElementById('mistralKey');
  var elevenlabsInput = document.getElementById('elevenlabsKey');
  var saveBtn = document.getElementById('saveBtn');
  var status = document.getElementById('status');

  function setStatus(text, isError) {
    status.textContent = text;
    status.style.color = isError ? '#cb1f27' : '#0a7f3f';
  }

  async function loadKeys() {
    try {
      var data = await chrome.storage.local.get(['mistral_api_key', 'elevenlabs_api_key']);
      mistralInput.value = data.mistral_api_key || '';
      elevenlabsInput.value = data.elevenlabs_api_key || '';
    } catch (err) {
      setStatus('Failed to load keys: ' + (err && err.message ? err.message : String(err)), true);
    }
  }

  async function saveKeys() {
    try {
      await chrome.storage.local.set({
        mistral_api_key: mistralInput.value.trim(),
        elevenlabs_api_key: elevenlabsInput.value.trim()
      });
      setStatus('Saved.', false);
    } catch (err) {
      setStatus('Failed to save keys: ' + (err && err.message ? err.message : String(err)), true);
    }
  }

  saveBtn.addEventListener('click', function () {
    saveKeys().catch(function (err) {
      setStatus('Failed to save keys: ' + (err && err.message ? err.message : String(err)), true);
    });
  });

  loadKeys().catch(function (err) {
    setStatus('Failed to load keys: ' + (err && err.message ? err.message : String(err)), true);
  });
})();
