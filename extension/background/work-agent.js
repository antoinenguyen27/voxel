import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatMistralAI } from '@langchain/mistralai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MemorySaver } from '@langchain/langgraph-checkpoint';

const WORK_AGENT_SYSTEM_PROMPT = `You are a browser automation agent running inside a Chrome extension.

Your job: execute the user's instruction by writing and running JavaScript in their active browser tab.

Workflow:
1. Read relevant skills with read_skills to find known action patterns for this website.
2. Write and execute targeted JavaScript using execute_page_code.
3. Verify the result. If it failed, try an alternative approach.
4. Report back in a single, concise sentence what you did.

Rules:
- Only use the provided helper functions: click(), setValue(), waitForElement(), delay(). Do not use document.querySelector directly in one-liners — use waitForElement for reliability.
- Never navigate away from the page unless explicitly asked.
- Never fill in credentials or submit payment forms.
- If a skill exists for the task, follow its action sequence exactly.
- Keep your final response to 1-2 sentences — it will be read aloud to the user.`;

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
        'Execute JavaScript in the active browser tab to interact with page elements. Use the helper functions: click(selector), setValue(selector, value), waitForElement(selector), delay(ms). Always await async operations.',
      schema: z.object({
        description: z.string().describe('Plain English description of what this code does'),
        code: z.string().describe('JavaScript code to execute. Must use only the provided helpers.')
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
    tools: [executePageCodeTool, readSkillsTool, readMemoryTool],
    checkpointSaver,
    messageModifier: WORK_AGENT_SYSTEM_PROMPT
  });
}
