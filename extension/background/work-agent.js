import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatMistralAI } from '@langchain/mistralai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MemorySaver } from '@langchain/langgraph-checkpoint';

const WORK_AGENT_SYSTEM_PROMPT = `You are a browser automation agent running inside a Chrome extension.

Your job: execute the user's instruction safely and deterministically in their active browser tab.

Workflow:
1. Read relevant skills with read_skills to find known action patterns for this website.
2. Inspect current page structure with inspect_page_map (summary first; use zoom for ambiguous regions).
3. For ambiguous targets, call get_action_context on candidate selectors before acting.
4. Execute interaction plans using execute_actions (typed action list only).
5. Verify the result. If it failed, use a better selector strategy and retry once.
6. Report back in a single, concise sentence what you did.

Rules:
- Never generate or request raw JavaScript execution.
- Use only typed actions via execute_actions.
- Never navigate away from the page unless explicitly asked.
- Never fill in credentials or submit payment forms.
- If a skill exists for the task, follow its action sequence exactly.
- For underspecified instructions, call inspect_page_map before acting.
- Confidence policy (prompt-level only): before any execute_actions call, internally rate target confidence as high/medium/low.
- If low confidence, ask one concise clarifying question instead of executing.
- If medium confidence, run inspect_page_map zoom and/or get_action_context first, then execute.
- If execute_actions returns selector/timeouts, inspect again and retry with improved selectors once.
- Do not claim CSP or permission issues unless the tool error code explicitly indicates that category.
- Keep your final response to 1-2 sentences — it will be read aloud to the user.`;

const MAX_JSON_PREVIEW = 12000;

const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('waitForElement'),
    selector: z.string().min(1).max(500),
    timeoutMs: z.number().int().min(250).max(20000).optional()
  }),
  z.object({
    type: z.literal('click'),
    selector: z.string().min(1).max(500)
  }),
  z.object({
    type: z.literal('fill'),
    selector: z.string().min(1).max(500),
    value: z.string().max(2000)
  }),
  z.object({
    type: z.literal('type'),
    selector: z.string().min(1).max(500),
    text: z.string().max(2000)
  }),
  z.object({
    type: z.literal('selectOptions'),
    selector: z.string().min(1).max(500),
    value: z.string().max(500)
  }),
  z.object({
    type: z.literal('keyboard'),
    key: z.string().min(1).max(64)
  }),
  z.object({
    type: z.literal('delay'),
    ms: z.number().int().min(0).max(20000)
  }),
  z.object({
    type: z.literal('readText'),
    selector: z.string().min(1).max(500),
    timeoutMs: z.number().int().min(250).max(20000).optional()
  })
]);

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

function toJsonPreview(value) {
  const json = JSON.stringify(value == null ? {} : value);
  if (json.length <= MAX_JSON_PREVIEW) {
    return json;
  }
  return json.slice(0, MAX_JSON_PREVIEW - 1) + '…';
}

function formatCommandError(result, fallback) {
  const code = result?.errorCode ? ` [${result.errorCode}]` : '';
  return `Error${code}: ${result?.error || fallback}`;
}

export async function buildWorkAgent({ tabId, executeExecutorCommand, loadAllSkills, getSessionMemory }) {
  const apiKey = await getStoredApiKey('mistral');
  if (!apiKey) {
    throw new Error('Missing Mistral API key. Set it in extension options.');
  }

  const llm = new ChatMistralAI({
    model: 'mistral-large-latest',
    apiKey,
    temperature: 0.1
  });

  const inspectPageMapTool = tool(
    async ({ mode, targetSelector, depth, maxNodes, frameId }) => {
      try {
        const result = await executeExecutorCommand({
          tabId,
          command: 'INSPECT_PAGE_MAP',
          args: { mode, targetSelector, depth, maxNodes },
          frameId
        });
        if (!result || !result.success) {
          return formatCommandError(result, 'inspection failed');
        }
        return toJsonPreview(result.output);
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
        targetSelector: z.string().max(500).optional().describe('Required for zoom mode; selector of region/element to inspect'),
        depth: z.number().int().min(1).max(7).optional().describe('Traversal depth cap'),
        maxNodes: z.number().int().min(20).max(500).optional().describe('Node count cap'),
        frameId: z.number().int().min(0).optional().describe('Optional frame id for same-origin frame targeting')
      })
    }
  );

  const getActionContextTool = tool(
    async ({ selector, radius, maxSiblings, maxChildren, frameId }) => {
      try {
        const result = await executeExecutorCommand({
          tabId,
          command: 'GET_ACTION_CONTEXT',
          args: { selector, radius, maxSiblings, maxChildren },
          frameId
        });
        if (!result || !result.success) {
          return formatCommandError(result, 'action context inspection failed');
        }
        return toJsonPreview(result.output);
      } catch (err) {
        return `Error getting action context: ${err && err.message ? err.message : String(err)}`;
      }
    },
    {
      name: 'get_action_context',
      description:
        'Inspect a local neighborhood around one selector (target node, ancestry, siblings, descendants) to resolve ambiguity before acting.',
      schema: z.object({
        selector: z.string().min(1).max(500).describe('Stable selector for the candidate target element'),
        radius: z.number().int().min(1).max(6).optional().describe('How many ancestor levels to include'),
        maxSiblings: z.number().int().min(2).max(20).optional().describe('Max sibling nodes to include'),
        maxChildren: z.number().int().min(4).max(40).optional().describe('Max descendant nodes to include'),
        frameId: z.number().int().min(0).optional().describe('Optional frame id for same-origin frame targeting')
      })
    }
  );

  const executeActionsTool = tool(
    async ({ summary, actions, frameId }) => {
      try {
        const result = await executeExecutorCommand({
          tabId,
          command: 'RUN_ACTIONS',
          args: { actions, summary },
          frameId
        });
        if (!result || !result.success) {
          return formatCommandError(result, 'action execution failed');
        }
        return toJsonPreview(result.output);
      } catch (err) {
        return `Error running actions: ${err && err.message ? err.message : String(err)}`;
      }
    },
    {
      name: 'execute_actions',
      description:
        'Execute deterministic browser actions. Use a short summary and a typed action list; never send raw JavaScript.',
      schema: z.object({
        summary: z.string().max(300).describe('Short purpose of this action batch'),
        actions: z.array(ActionSchema).min(1).max(25).describe('Typed actions to execute in order'),
        frameId: z.number().int().min(0).optional().describe('Optional frame id for same-origin frame targeting')
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
    tools: [executeActionsTool, inspectPageMapTool, getActionContextTool, readSkillsTool, readMemoryTool],
    checkpointSaver,
    messageModifier: WORK_AGENT_SYSTEM_PROMPT
  });
}
