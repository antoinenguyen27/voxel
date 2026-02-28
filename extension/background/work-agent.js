import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatMistralAI } from '@langchain/mistralai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MemorySaver } from '@langchain/langgraph-checkpoint';

const WORK_AGENT_SYSTEM_PROMPT = `You are a browser automation agent running inside a Chrome extension.

Your job: execute the user's instruction by writing and running JavaScript in their active browser tab.

Workflow:
1. Read relevant skills with read_skills to find known action patterns for this website.
2. Inspect current page structure with inspect_page_map (summary first; use zoom for ambiguous regions).
3. For ambiguous targets, call get_action_context on candidate selectors before acting.
4. Write and execute targeted JavaScript using execute_page_code.
5. Verify the result. If it failed, try an alternative approach.
6. Report back in a single, concise sentence what you did.

Rules:
- Only use the provided helper functions: click(), fill(), type(), selectOptions(), keyboard(), setValue(), waitForElement(), delay(). setValue is a legacy alias of fill.
- Prefer helper-based actions over raw dispatchEvent logic.
- Never navigate away from the page unless explicitly asked.
- Never fill in credentials or submit payment forms.
- If a skill exists for the task, follow its action sequence exactly.
- For underspecified instructions, always call inspect_page_map before executing changes.
- Confidence policy (prompt-level only): before any execute_page_code call, internally rate target confidence as high/medium/low.
- If low confidence, ask one concise clarifying question instead of executing.
- If medium confidence, run inspect_page_map zoom and/or get_action_context first, then execute.
- Keep your final response to 1-2 sentences — it will be read aloud to the user.`;

function buildPageMapCode({ mode, targetSelector, depth, maxNodes }) {
  const modeJson = JSON.stringify(mode || 'summary');
  const selectorJson = JSON.stringify(targetSelector || '');
  const depthJson = Number.isFinite(depth) ? Math.max(1, Math.min(7, depth)) : 4;
  const maxNodesJson = Number.isFinite(maxNodes) ? Math.max(20, Math.min(500, maxNodes)) : 180;

  return `
    const __uaMode = ${modeJson};
    const __uaTargetSelector = ${selectorJson};
    const __uaDepth = ${depthJson};
    const __uaMaxNodes = ${maxNodesJson};

    function __uaText(value, maxLen = 80) {
      const text = String(value || '').replace(/\\s+/g, ' ').trim();
      return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
    }

    function __uaSelector(el) {
      try {
        if (window.__getStableSelector) {
          return window.__getStableSelector(el);
        }
      } catch (_err) {}
      return null;
    }

    function __uaInteractive(el) {
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toUpperCase();
      if (['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'].includes(tag)) return true;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (['button', 'link', 'textbox', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'combobox'].includes(role)) return true;
      if (el.hasAttribute('contenteditable')) return true;
      const tabIndex = el.getAttribute('tabindex');
      return tabIndex !== null && tabIndex !== '-1';
    }

    function __uaNodeInfo(el, depth, path) {
      const role = el.getAttribute('role') || null;
      const label = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || null;
      return {
        tag: el.tagName ? el.tagName.toLowerCase() : 'unknown',
        role,
        selector: __uaSelector(el),
        text: __uaText(el.innerText || el.textContent || '', 100),
        label: __uaText(label || '', 80),
        depth,
        path,
        interactive: __uaInteractive(el)
      };
    }

    function __uaCollect(root, maxDepth, maxNodes) {
      const nodes = [];
      const queue = [{ el: root, depth: 0, path: '0' }];
      while (queue.length && nodes.length < maxNodes) {
        const current = queue.shift();
        const el = current.el;
        if (!el || !el.tagName) continue;
        nodes.push(__uaNodeInfo(el, current.depth, current.path));
        if (current.depth >= maxDepth) continue;
        const children = Array.from(el.children || []);
        for (let i = 0; i < children.length; i += 1) {
          queue.push({ el: children[i], depth: current.depth + 1, path: current.path + '.' + i });
          if (queue.length + nodes.length >= maxNodes * 2) break;
        }
      }
      const interactive = nodes.filter((n) => n.interactive).slice(0, Math.floor(maxNodes * 0.6));
      const landmarks = nodes.filter((n) => ['main', 'nav', 'section', 'form', 'table', 'header', 'footer', 'aside'].includes(n.tag) || n.role === 'dialog').slice(0, 80);
      return { nodes, interactive, landmarks };
    }

    function __uaFrameSummary(doc, url, title, root, modeLabel) {
      const collect = __uaCollect(root, __uaDepth, __uaMaxNodes);
      return {
        mode: modeLabel,
        frameUrl: url,
        frameTitle: __uaText(title || '', 120),
        totalNodes: collect.nodes.length,
        interactiveCount: collect.interactive.length,
        landmarks: collect.landmarks,
        interactive: collect.interactive
      };
    }

    const __uaTopRoot = document.documentElement || document.body;
    let __uaTarget = null;
    if (__uaMode === 'zoom' && __uaTargetSelector) {
      try { __uaTarget = document.querySelector(__uaTargetSelector); } catch (_err) { __uaTarget = null; }
    }
    const __uaBase = __uaTarget || __uaTopRoot;

    const result = {
      mode: __uaMode,
      url: window.location.href,
      title: __uaText(document.title || '', 140),
      focusedSelector: __uaSelector(document.activeElement),
      targetSelector: __uaTargetSelector || null,
      targetFound: !!__uaTarget,
      frameSummaries: []
    };

    result.frameSummaries.push(
      __uaFrameSummary(document, window.location.href, document.title || '', __uaBase, __uaMode + ':top')
    );

    const iframeEls = Array.from(document.querySelectorAll('iframe')).slice(0, 8);
    for (const frameEl of iframeEls) {
      try {
        const frameDoc = frameEl.contentDocument;
        const frameWin = frameEl.contentWindow;
        if (!frameDoc || !frameWin) continue;
        const frameRoot = frameDoc.documentElement || frameDoc.body;
        if (!frameRoot) continue;
        result.frameSummaries.push(
          __uaFrameSummary(frameDoc, frameWin.location ? frameWin.location.href : 'about:blank', frameDoc.title || '', frameRoot, __uaMode + ':iframe')
        );
      } catch (_err) {
        result.frameSummaries.push({
          mode: __uaMode + ':iframe',
          frameUrl: frameEl.src || 'cross-origin',
          frameTitle: '',
          inaccessible: true
        });
      }
    }

    return result;
  `;
}

function buildActionContextCode({ selector, radius, maxSiblings, maxChildren }) {
  const selectorJson = JSON.stringify(selector || '');
  const radiusJson = Number.isFinite(radius) ? Math.max(1, Math.min(6, radius)) : 3;
  const siblingsJson = Number.isFinite(maxSiblings) ? Math.max(2, Math.min(20, maxSiblings)) : 8;
  const childrenJson = Number.isFinite(maxChildren) ? Math.max(4, Math.min(40, maxChildren)) : 16;

  return `
    const __uaSelectorInput = ${selectorJson};
    const __uaRadius = ${radiusJson};
    const __uaMaxSiblings = ${siblingsJson};
    const __uaMaxChildren = ${childrenJson};

    function __uaText(value, maxLen = 90) {
      const text = String(value || '').replace(/\\s+/g, ' ').trim();
      return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
    }

    function __uaSelector(el) {
      try {
        if (window.__getStableSelector) {
          return window.__getStableSelector(el);
        }
      } catch (_err) {}
      return null;
    }

    function __uaNode(el) {
      if (!el || !el.tagName) return null;
      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        selector: __uaSelector(el),
        ariaLabel: el.getAttribute('aria-label') || null,
        name: el.getAttribute('name') || null,
        placeholder: el.getAttribute('placeholder') || null,
        text: __uaText(el.innerText || el.textContent || '', 100),
        visible: !!(rect && rect.width > 0 && rect.height > 0),
        bounds: rect
          ? {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            }
          : null
      };
    }

    let __uaTarget = null;
    try {
      __uaTarget = document.querySelector(__uaSelectorInput);
    } catch (_err) {
      __uaTarget = null;
    }

    const result = {
      url: window.location.href,
      frameTitle: __uaText(document.title || '', 120),
      requestedSelector: __uaSelectorInput,
      found: !!__uaTarget,
      target: __uaNode(__uaTarget),
      ancestry: [],
      siblings: [],
      descendants: []
    };

    if (!__uaTarget) {
      return result;
    }

    let current = __uaTarget.parentElement;
    let depth = 0;
    while (current && depth < __uaRadius) {
      const node = __uaNode(current);
      if (node) {
        result.ancestry.push(node);
      }
      current = current.parentElement;
      depth += 1;
    }

    const siblings = Array.from((__uaTarget.parentElement && __uaTarget.parentElement.children) || [])
      .filter((el) => el !== __uaTarget)
      .slice(0, __uaMaxSiblings);
    for (const sib of siblings) {
      const node = __uaNode(sib);
      if (node) {
        result.siblings.push(node);
      }
    }

    const stack = Array.from(__uaTarget.children || []).slice(0, __uaMaxChildren);
    while (stack.length && result.descendants.length < __uaMaxChildren) {
      const el = stack.shift();
      const node = __uaNode(el);
      if (node) {
        result.descendants.push(node);
      }
      const kids = Array.from(el.children || []);
      for (let i = 0; i < kids.length; i += 1) {
        if (stack.length >= __uaMaxChildren * 2) break;
        stack.push(kids[i]);
      }
    }

    return result;
  `;
}

async function getStoredApiKey(service = 'mistral') {
  try {
    const key = service === 'mistral' ? 'mistral_api_key' : 'elevenlabs_api_key';
    const result = await chrome.storage.local.get(key);
    return result[key] || '';
  } catch (err) {
    console.error('[work-agent] getStoredApiKey failed', err);
    return '';
  }
}

function formatMemory(sessionMemory) {
  if (!sessionMemory.length) {
    return 'No previous tasks this session.';
  }
  return sessionMemory
    .map((m) => `[${new Date(m.timestamp).toLocaleTimeString()}] Task: ${m.task}\nResult: ${m.result}`)
    .join('\n\n');
}

export async function buildWorkAgent({ tabId, executePageCode, loadAllSkills, getSessionMemory }) {
  const apiKey = await getStoredApiKey('mistral');
  if (!apiKey) {
    throw new Error('Missing Mistral API key. Set it in extension options.');
  }

  const llm = new ChatMistralAI({
    model: 'mistral-large-latest',
    apiKey,
    temperature: 0.1
  });

  const executePageCodeTool = tool(
    async ({ code, description }) => {
      try {
        const result = await executePageCode({ tabId, code, description });
        if (result && result.success) {
          return `Success: ${result.output ?? 'action completed'}`;
        }
        return `Error: ${result?.error || 'unknown execution error'}`;
      } catch (err) {
        return `Error: ${err && err.message ? err.message : String(err)}`;
      }
    },
    {
      name: 'execute_page_code',
      description:
        'Execute JavaScript in the active browser tab to interact with page elements. Use only helper functions: click(selector), fill(selector, value), type(selector, text), selectOptions(selector, value), keyboard(key), setValue(selector, value), waitForElement(selector), delay(ms). Always await async operations.',
      schema: z.object({
        description: z.string().describe('Plain English description of what this code does'),
        code: z.string().describe('JavaScript code to execute. Must use only the provided helpers.')
      })
    }
  );

  const inspectPageMapTool = tool(
    async ({ mode, targetSelector, depth, maxNodes }) => {
      try {
        const code = buildPageMapCode({ mode, targetSelector, depth, maxNodes });
        const result = await executePageCode({
          tabId,
          description: `Inspect page structure (${mode})`,
          code
        });
        if (!result || !result.success) {
          return `Error: ${result?.error || 'inspection failed'}`;
        }
        const output = result.output == null ? {} : result.output;
        const json = JSON.stringify(output);
        if (json.length > 12000) {
          return json.slice(0, 11999) + '…';
        }
        return json;
      } catch (err) {
        return `Error inspecting page map: ${err && err.message ? err.message : String(err)}`;
      }
    },
    {
      name: 'inspect_page_map',
      description:
        'Inspect current page structure for grounding. Use mode=summary first; then mode=zoom with a targetSelector for deeper local structure.',
      schema: z.object({
        mode: z.enum(['summary', 'zoom']).describe('summary for global map, zoom for target region'),
        targetSelector: z.string().optional().describe('Required for zoom mode; selector of region/element to inspect'),
        depth: z.number().int().min(1).max(7).optional().describe('Traversal depth cap'),
        maxNodes: z.number().int().min(20).max(500).optional().describe('Node count cap')
      })
    }
  );

  const getActionContextTool = tool(
    async ({ selector, radius, maxSiblings, maxChildren }) => {
      try {
        const code = buildActionContextCode({ selector, radius, maxSiblings, maxChildren });
        const result = await executePageCode({
          tabId,
          description: `Get local action context for selector: ${selector}`,
          code
        });
        if (!result || !result.success) {
          return `Error: ${result?.error || 'action context inspection failed'}`;
        }
        const output = result.output == null ? {} : result.output;
        const json = JSON.stringify(output);
        if (json.length > 12000) {
          return json.slice(0, 11999) + '…';
        }
        return json;
      } catch (err) {
        return `Error getting action context: ${err && err.message ? err.message : String(err)}`;
      }
    },
    {
      name: 'get_action_context',
      description:
        'Inspect a local neighborhood around one selector (target node, ancestry, siblings, descendants) to resolve ambiguity before acting.',
      schema: z.object({
        selector: z.string().describe('Stable selector for the candidate target element'),
        radius: z.number().int().min(1).max(6).optional().describe('How many ancestor levels to include'),
        maxSiblings: z.number().int().min(2).max(20).optional().describe('Max sibling nodes to include'),
        maxChildren: z.number().int().min(4).max(40).optional().describe('Max descendant nodes to include')
      })
    }
  );

  const readSkillsTool = tool(
    async ({ query }) => {
      try {
        const skills = await loadAllSkills();
        if (!skills.length) {
          return 'No skills recorded yet.';
        }
        const queryWords = String(query || '')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);

        const relevant = skills.filter((s) => {
          const name = String(s.name || '').toLowerCase();
          const description = String(s.description || s.content || '').toLowerCase();
          return queryWords.some((w) => name.includes(w) || description.includes(w));
        });

        if (relevant.length > 0) {
          return relevant.map((s) => `## ${s.name}\n${s.content}`).join('\n\n---\n\n');
        }

        return `No relevant skills found for: ${query}. Available: ${skills.map((s) => s.name).join(', ')}`;
      } catch (err) {
        return `Error reading skills: ${err && err.message ? err.message : String(err)}`;
      }
    },
    {
      name: 'read_skills',
      description: 'Read recorded SKILL.md files to find how to perform tasks on websites.',
      schema: z.object({
        query: z.string().describe('What task or action you are looking for')
      })
    }
  );

  const readMemoryTool = tool(
    async () => {
      try {
        const memory = getSessionMemory();
        return formatMemory(memory);
      } catch (err) {
        return `Error reading session memory: ${err && err.message ? err.message : String(err)}`;
      }
    },
    {
      name: 'read_session_memory',
      description: 'Read what tasks have been completed so far in this session.',
      schema: z.object({})
    }
  );

  const checkpointSaver = new MemorySaver();

  return createReactAgent({
    llm,
    tools: [executePageCodeTool, inspectPageMapTool, getActionContextTool, readSkillsTool, readMemoryTool],
    checkpointSaver,
    messageModifier: WORK_AGENT_SYSTEM_PROMPT
  });
}
