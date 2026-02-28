const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

export const SKILL_WRITER_SYSTEM_PROMPT = `You write SKILL.md files for a browser automation agent.

Given a voice narration and a list of observed browser events, write a structured skill file.

Output ONLY the skill markdown. Format:

# [Concise skill name, e.g. "Add a new slide in Google Slides"]

## Description
[What this skill does, 1-2 sentences]

## Preconditions
- [State the page/app must be in]

## Actions
\`\`\`javascript
// Execution code using only these helpers:
// click(selector), setValue(selector, value), waitForElement(selector), delay(ms)
// All are async — always await them.

await click('[aria-label="New slide"]');
await waitForElement('.punch-viewer-container');
\`\`\`

## Network Signature (optional)
If the action triggers a specific network call, document it here for verification.
Method: POST
URL pattern: /presentations/*/slides

## Confidence
[high|medium|low] — based on selector quality and whether network evidence corroborates DOM events.

## Notes
[Any caveats — e.g. canvas-rendered UI, iframe context, React synthetic events]

Rules:
- Use aria-label selectors preferentially. They are the most stable.
- If a selector is marked low confidence (nth-child), note it and suggest the user re-record.
- If the voice narration is ambiguous, write the most conservative interpretation.
- Never include credentials, personal data, or full URL paths with document IDs.`;

async function getStoredApiKey(service = 'mistral') {
  try {
    const key = service === 'mistral' ? 'mistral_api_key' : 'elevenlabs_api_key';
    const result = await chrome.storage.local.get(key);
    return result[key] || '';
  } catch (err) {
    console.error('[skill-writer] getStoredApiKey failed', err);
    return '';
  }
}

function extractResponseText(data) {
  try {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n').trim();
    }
    return '';
  } catch (_err) {
    return '';
  }
}

export async function writeSkillFromSegment(transcript, events) {
  try {
    const apiKey = await getStoredApiKey('mistral');
    if (!apiKey) {
      throw new Error('Missing Mistral API key. Set it in extension options.');
    }

    const eventSummary = formatEventsForPrompt(events || []);
    const response = await fetch(MISTRAL_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        temperature: 0.1,
        messages: [
          { role: 'system', content: SKILL_WRITER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Voice narration: "${String(transcript || '')}"\n\nObserved events:\n${eventSummary}`
          }
        ]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Mistral skill generation failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const skillText = extractResponseText(data);
    if (!skillText) {
      throw new Error('Mistral returned empty skill content.');
    }

    const nameMatch = skillText.match(/^#\s+(.+)$/m);
    const skillName = (nameMatch && nameMatch[1] ? nameMatch[1].trim() : '') || `skill-${Date.now()}`;
    await saveSkill(skillName, skillText);
    return skillName;
  } catch (err) {
    console.error('[skill-writer] writeSkillFromSegment failed', err);
    throw err;
  }
}

export function formatEventsForPrompt(events) {
  try {
    function formatTs(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts)) {
        return 'unknown-time';
      }
      if (ts >= 0 && ts < 24 * 60 * 60 * 1000) {
        return `${(ts / 1000).toFixed(2)}s`;
      }
      return new Date(ts).toISOString();
    }

    return (events || [])
      .map((e) => {
        if (e?.type === 'DOM_EVENT') {
          return `[${formatTs(e.timestamp)}] [${e.eventType}] ${e.tag} | selector: ${e.selector} | label: ${e.ariaLabel} | value: ${e.value} | confidence: ${e.confidence}`;
        }
        if (e?.type === 'DOM_MUTATION') {
          const summary = Array.isArray(e.summary)
            ? e.summary.map((s) => `${s.kind} on ${s.target}`).join(', ')
            : '';
          return `[${formatTs(e.timestamp)}] [mutation] ${e.count} changes | ${summary}`;
        }
        if (e?.type === 'NETWORK_FETCH' || e?.type === 'NETWORK_XHR') {
          return `[${formatTs(e.timestamp)}] [network] ${e.method} ${e.url} → ${e.status}`;
        }
        return JSON.stringify(e);
      })
      .join('\n');
  } catch (err) {
    console.error('[skill-writer] formatEventsForPrompt failed', err);
    return '';
  }
}

export async function saveSkill(name, content) {
  try {
    const normalized = String(name || `skill-${Date.now()}`)
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase();
    const key = `skill_${normalized}`;
    await chrome.storage.local.set({
      [key]: {
        name,
        content,
        createdAt: Date.now()
      }
    });
    return key;
  } catch (err) {
    console.error('[skill-writer] saveSkill failed', err);
    throw err;
  }
}

export async function loadAllSkills() {
  try {
    const all = await chrome.storage.local.get(null);
    return Object.values(all).filter((v) => v && v.name && v.content);
  } catch (err) {
    console.error('[skill-writer] loadAllSkills failed', err);
    return [];
  }
}
