const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

export const SKILL_WRITER_SYSTEM_PROMPT = `You write SKILL.md files for a browser automation agent.

You will be given a voice narration describing what the user intended, and a list of classified actions that were observed during that narration. The actions are already in executable form — your job is to select the meaningful ones (ignoring accidental or redundant actions), and write a skill that reproduces the user's intent.

The execution environment provides exactly these helpers, all async:
- click(selector)
- fill(selector, value)
- type(selector, text)        — use for rich text editors only; prefer fill for normal inputs
- selectOptions(selector, value)
- keyboard(key)               — for Enter, Escape, Tab, arrow keys
- waitForElement(selector, timeoutMs)
- delay(ms)

Output ONLY the skill markdown. Format:

# [Concise skill name, e.g. "Add a new slide in Google Slides"]

## Description
[What this skill does, 1 sentence]

## Preconditions
- [Required state of the page before this skill runs]

## Actions
\`\`\`javascript
// Use only the helpers listed above. Always await them.
await click('[aria-label="New slide"]');
\`\`\`

## Network Signature (if present)
Method: POST
URL pattern: /presentations/*/slides

## Confidence
[high | medium | low]
- high: aria-label or stable data-* selectors, corroborated by network call
- medium: role/class selectors, no network corroboration
- low: positional selectors (nth-child), ambiguous actions

## Notes
[Caveats only — omit if none. E.g. canvas UI, cross-origin iframe, React contenteditable]

Rules:
- Prefer aria-label selectors. They are the most stable.
- If multiple clicks happened before the target, include only the one that achieved the intent.
- If the voice narration and action list disagree, trust the action list and note the discrepancy.
- Never include credentials, document IDs, or full URLs with user-specific path segments.
- If confidence is low, add a note recommending the user re-record this skill.`;

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

export async function writeSkillFromSegment(transcript, actions) {
  try {
    const apiKey = await getStoredApiKey('mistral');
    if (!apiKey) {
      throw new Error('Missing Mistral API key. Set it in extension options.');
    }

    const actionSummary = formatActionsForPrompt(actions || []);
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
            content: `Voice narration: "${String(transcript || '')}"\n\nObserved actions:\n${actionSummary}`
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

export function formatActionsForPrompt(actions) {
  try {
    return (actions || [])
      .map((a) => {
        switch (a?.action) {
          case 'click':
            return `[click] ${a.tag || 'element'} | selector: ${a.selector} | label: "${a.ariaLabel || ''}" | text: "${a.innerText || ''}"`;
          case 'fill':
            return `[fill] selector: ${a.selector} | label: "${a.ariaLabel || ''}" | value: "${a.value}"`;
          case 'selectOptions':
            return `[selectOptions] selector: ${a.selector} | value: "${a.value}"`;
          case 'keyboard':
            return `[keyboard] key: ${a.key}`;
          case 'network':
            return `[network] ${a.method} ${a.url} → ${a.status}`;
          default:
            return JSON.stringify(a);
        }
      })
      .join('\n');
  } catch (err) {
    console.error('[skill-writer] formatActionsForPrompt failed', err);
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
