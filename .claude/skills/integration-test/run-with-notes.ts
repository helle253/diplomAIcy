import 'dotenv/config';

import {
  AgentConfig,
  getAgentConfig,
  loadConfig,
  toLLMClientConfig,
} from '../../../src/agent/llm/config';
import { OpenAICompatibleClient } from '../../../src/agent/llm/llm-client';
import { connectToolAgent } from '../../../src/agent/llm/tool-agent';
import { connectRandomAgent } from '../../../src/agent/random-agent';
import { createGameClient } from '../../../src/agent/remote/client';
import { Power } from '../../../src/engine/types';
import { NoteKeepingClient } from './note-keeping-client';

const VALID_POWERS = new Set<string>(Object.values(Power));

function isPower(value: string): value is Power {
  return VALID_POWERS.has(value);
}

function parseArgs(): {
  power: Power;
  server: string;
  type?: string;
  lobbyId: string;
  notesDir: string;
} {
  const args = process.argv.slice(2);
  let power: string | undefined;
  let server = process.env.GAME_SERVER ?? 'http://localhost:3000/trpc';
  let type: string | undefined;
  let lobbyId: string | undefined;
  let notesDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--power' && args[i + 1]) {
      power = args[++i];
    } else if (args[i] === '--server' && args[i + 1]) {
      server = args[++i];
    } else if (args[i] === '--type' && args[i + 1]) {
      type = args[++i];
    } else if (args[i] === '--lobby' && args[i + 1]) {
      lobbyId = args[++i];
    } else if (args[i] === '--notes-dir' && args[i + 1]) {
      notesDir = args[++i];
    }
  }

  if (!power || !isPower(power)) {
    console.error(
      `Usage: npx tsx run-with-notes.ts --power <Power> --lobby <lobbyId> --notes-dir <dir> [--server <url>] [--type random|llm]\n` +
        `  Valid powers: ${[...VALID_POWERS].join(', ')}`,
    );
    process.exit(1);
  }

  if (!lobbyId) {
    console.error('--lobby is required');
    process.exit(1);
  }

  if (!notesDir) {
    console.error('--notes-dir is required');
    process.exit(1);
  }

  return { power, server, type, lobbyId, notesDir };
}

function resolveAgentConfig(power: Power, typeOverride?: string): AgentConfig {
  const gameConfig = loadConfig();
  const cfg = getAgentConfig(gameConfig, power);

  if (typeOverride) {
    if (typeOverride !== 'llm' && typeOverride !== 'random') {
      throw new Error(`Unsupported --type "${typeOverride}". Expected llm or random.`);
    }
    cfg.type = typeOverride;
  }

  if ((cfg as { type: string }).type === 'remote') {
    cfg.type = 'llm';
  }

  if (cfg.type === 'llm') {
    cfg.provider ??= (process.env.LLM_PROVIDER as AgentConfig['provider']) ?? 'openai';
    cfg.baseUrl ??= process.env.LLM_BASE_URL;
    cfg.apiKey ??= process.env.LLM_API_KEY;
    cfg.model ??= process.env.LLM_MODEL;
  }

  return cfg;
}

async function main() {
  const { power, server, type, lobbyId, notesDir } = parseArgs();
  const cfg = resolveAgentConfig(power, type);

  // Join lobby
  const joinClient = createGameClient(server);
  let seatToken: string;
  try {
    const result = await joinClient.lobby.join.mutate({ lobbyId, power });
    seatToken = result.seatToken;
    console.log(`Joined lobby ${lobbyId} as ${power}`);
  } catch (err) {
    console.error(`Failed to join lobby ${lobbyId} as ${power}:`, err);
    process.exit(1);
  }

  // Wait for lobby to be playing
  const trpcClient = createGameClient(server, seatToken);
  const readyTimeoutMs = Number(process.env.LOBBY_READY_TIMEOUT_MS ?? 0);
  const deadline = readyTimeoutMs > 0 ? Date.now() + readyTimeoutMs : Number.POSITIVE_INFINITY;

  while (Date.now() < deadline || deadline === Number.POSITIVE_INFINITY) {
    try {
      await trpcClient.game.getState.query({ lobbyId });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (deadline !== Number.POSITIVE_INFINITY && Date.now() >= deadline) {
    throw new Error(`Lobby ${lobbyId} never became playable before timeout (${readyTimeoutMs}ms)`);
  }

  // Connect agent with NoteKeepingClient wrapper
  if (cfg.type === 'llm') {
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      console.error(
        `LLM agent for ${power} requires baseUrl, apiKey, model.\n` +
          `Set via config file (powers.${power}) or env vars: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL`,
      );
      process.exit(1);
    }
    if (cfg.provider === 'anthropic') {
      console.error('Anthropic provider does not support tool calling yet. Use openai provider.');
      process.exit(1);
    }
    const rawClient = new OpenAICompatibleClient(toLLMClientConfig(cfg));
    const llmClient = new NoteKeepingClient(rawClient, notesDir, power, lobbyId);
    console.log(
      `Starting tool-calling agent with notes for ${power} (${cfg.provider ?? 'openai'}/${cfg.model}), notes → ${notesDir}/${lobbyId}/${power}.md`,
    );
    await connectToolAgent(trpcClient, llmClient, power, lobbyId);
  } else {
    console.log(`Starting random agent for ${power}, connecting to ${server}...`);
    await connectRandomAgent(trpcClient, power, lobbyId);
  }

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
