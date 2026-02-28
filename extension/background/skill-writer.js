const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

export const SKILL_WRITER_SYSTEM_PROMPT = `You write SKILL.md files for a browser automation agent.

You will be given a voice narration describing what the user intended, and a list of classified actions that were observed during that narration. The actions are already in executable form — your job is to select the meaningful ones (ignoring accidental or redundant actions), and write a skill that reproduces the user's intent.

You may also receive timestamped transcript lines and timestamped action lines. Use temporal ordering to align intent with actions; prefer actions that occur near the narrated intent.
You may also receive an initial page scaffold and local action context metadata. Use these only to disambiguate targets.

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

function formatRelativeTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return '0.00s';
  }
  return `${(Math.max(0, ts) / 1000).toFixed(2)}s`;
}

function compactText(value, maxLen = 100) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function formatMapNodes(nodes, maxItems = 12) {
  const list = Array.isArray(nodes) ? nodes.slice(0, maxItems) : [];
  if (!list.length) {
    return 'none';
  }
  return list
    .map((n) => {
      const tag = n?.tag || 'element';
      const selector = compactText(n?.selector || 'null', 80);
      const label = compactText(n?.label || n?.text || '', 70);
      return `${tag} selector=${selector}${label ? ` label="${label}"` : ''}`;
    })
    .join('\n');
}

function formatActionContext(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return '';
  }
  const selector = compactText(ctx.selector || '', 90);
  const landmark = compactText(ctx.landmarkSelector || '', 90);
  const parent = compactText(ctx.parentSelector || '', 90);
  const tag = compactText(ctx.tag || '', 24);
  const role = compactText(ctx.role || '', 24);
  const frameUrl = compactText(ctx.frameUrl || '', 120);

  const parts = [];
  if (tag) parts.push(`tag=${tag}`);
  if (role) parts.push(`role=${role}`);
  if (selector) parts.push(`selector=${selector}`);
  if (parent) parts.push(`parent=${parent}`);
  if (landmark) parts.push(`landmark=${landmark}`);
  if (frameUrl) parts.push(`frame=${frameUrl}`);
  return parts.length ? ` | ctx: ${parts.join(' ')}` : '';
}

function formatPageContextForPrompt(pageContext) {
  const summary = pageContext?.summary || null;
  const zooms = Array.isArray(pageContext?.zooms) ? pageContext.zooms : [];
  if (!summary && !zooms.length) {
    return '';
  }

  const lines = [];
  if (summary) {
    lines.push(
      `Initial page scaffold: title="${compactText(summary.title || '', 120)}" url="${compactText(summary.url || '', 180)}" focused="${compactText(summary.focusedSelector || 'null', 120)}" nodes=${summary.totalNodes || 0}`
    );
    lines.push(`Landmarks:\n${formatMapNodes(summary.landmarks, 10)}`);
    lines.push(`Interactive candidates:\n${formatMapNodes(summary.interactive, 14)}`);
  }

  if (zooms.length) {
    lines.push('Targeted zooms:');
    for (const zoom of zooms.slice(0, 4)) {
      const map = zoom?.map || {};
      lines.push(
        `- selector="${compactText(zoom?.selector || 'null', 140)}" found=${!!map.targetFound} title="${compactText(
          map.title || '',
          80
        )}" nodes=${map.totalNodes || 0}`
      );
      lines.push(`  interactive:\n${formatMapNodes(map.interactive, 8)}`);
    }
  }

  return lines.join('\n\n').trim();
}

export async function writeSkillFromSegment(transcript, actions, options = {}) {
  try {
    const apiKey = await getStoredApiKey('mistral');
    if (!apiKey) {
      throw new Error('Missing Mistral API key. Set it in extension options.');
    }

    const transcriptTimeline = String(options?.transcriptTimeline || '').trim();
    const actionSummary = formatActionsForPrompt(actions || []);
    const pageContextSummary = formatPageContextForPrompt(options?.pageContext || null);
    const voiceSection = transcriptTimeline
      ? `Voice narration (timestamped):\n${transcriptTimeline}\n\nVoice narration (plain): "${String(transcript || '')}"`
      : `Voice narration: "${String(transcript || '')}"`;
    const promptInput = {
      voiceSection,
      observedActions: actionSummary,
      pageContext: pageContextSummary
    };
    const pageContextSection = pageContextSummary ? `\n\nPage context map:\n${pageContextSummary}` : '';

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
            content: `${voiceSection}\n\nObserved actions (timestamped):\n${actionSummary}${pageContextSection}`
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
    return {
      skillName,
      skillText,
      promptInput
    };
  } catch (err) {
    console.error('[skill-writer] writeSkillFromSegment failed', err);
    throw err;
  }
}

export function formatActionsForPrompt(actions) {
  try {
    return (actions || [])
      .map((a) => {
        const ts = `[${formatRelativeTime(a?.timestamp)}] `;
        switch (a?.action) {
          case 'click':
            return `${ts}[click] ${a.tag || 'element'} | selector: ${a.selector} | label: "${a.ariaLabel || ''}" | text: "${a.innerText || ''}"${formatActionContext(a?.context)}`;
          case 'fill':
            return `${ts}[fill] selector: ${a.selector} | label: "${a.ariaLabel || ''}" | value: "${a.value}"${formatActionContext(a?.context)}`;
          case 'selectOptions':
            return `${ts}[selectOptions] selector: ${a.selector} | value: "${a.value}"${formatActionContext(a?.context)}`;
          case 'keyboard':
            return `${ts}[keyboard] type: ${a.eventType || 'keydown'} | key: ${a.key} | code: ${a.code || ''} | ctrl:${!!a.ctrlKey} meta:${!!a.metaKey} alt:${!!a.altKey} shift:${!!a.shiftKey}${formatActionContext(a?.context)}`;
          case 'network':
            return `${ts}[network] ${a.method} ${a.url} → ${a.status}${formatActionContext(a?.context)}`;
          default:
            return `${ts}${JSON.stringify(a)}`;
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
    return Object.entries(all)
      .filter(([key, value]) => key.startsWith('skill_') && value && value.name && value.content)
      .map(([key, value]) => ({
        storageKey: key,
        ...value
      }));
  } catch (err) {
    console.error('[skill-writer] loadAllSkills failed', err);
    return [];
  }
}

export async function deleteSkill(storageKey) {
  try {
    if (!storageKey || typeof storageKey !== 'string' || !storageKey.startsWith('skill_')) {
      throw new Error('Invalid skill key.');
    }
    await chrome.storage.local.remove(storageKey);
    return true;
  } catch (err) {
    console.error('[skill-writer] deleteSkill failed', err);
    throw err;
  }
}
