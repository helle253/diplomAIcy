import 'dotenv/config';

import { Power } from '../../engine/types';
import { AnthropicClient } from '../llm/anthropic-client';
import { AgentConfig, getAgentConfig, loadConfig, toLLMClientConfig } from '../llm/config';
import { OpenAICompatibleClient } from '../llm/llm-client';
import { connectToolAgent } from '../llm/tool-agent';
import { connectRandomAgent } from '../random-agent';
import { createGameClient } from './client';

const VALID_POWERS = new Set<string>(Object.values(Power));

function isPower(value: string): value is Power {
  return VALID_POWERS.has(value);
}

function parseArgs(): {
  power: Power;
  server: string;
  type?: string;
  lobbyId: string;
  planDir?: string;
} {
  const args = process.argv.slice(2);
  let power: string | undefined;
  let server = process.env.GAME_SERVER ?? 'http://localhost:3000/trpc';
  let type: string | undefined;
  let lobbyId: string | undefined;
  let planDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--power' && args[i + 1]) {
      power = args[++i];
    } else if (args[i] === '--server' && args[i + 1]) {
      server = args[++i];
    } else if (args[i] === '--type' && args[i + 1]) {
      type = args[++i];
    } else if (args[i] === '--lobby' && args[i + 1]) {
      lobbyId = args[++i];
    } else if (args[i] === '--plan-dir' && args[i + 1]) {
      planDir = args[++i];
    }
  }

  if (!power || !isPower(power)) {
    console.error(
      `Usage: node run.js --power <Power> --lobby <lobbyId> [--server <url>] [--type random|llm]\n` +
        `  Valid powers: ${[...VALID_POWERS].join(', ')}`,
    );
    process.exit(1);
  }

  if (!lobbyId) {
    console.error(
      `Usage: node run.js --power <Power> --lobby <lobbyId> [--server <url>] [--type random|llm]\n` +
        `  --lobby is required`,
    );
    process.exit(1);
  }

  return { power, server, type, lobbyId, planDir };
}

function resolveAgentConfig(power: Power, typeOverride?: string): AgentConfig {
  // Try loading per-power config from the game config file
  const gameConfig = loadConfig();
  const cfg = getAgentConfig(gameConfig, power);

  // CLI --type flag overrides config file
  if (typeOverride) {
    cfg.type = typeOverride as AgentConfig['type'];
  }

  // 'remote' doesn't make sense for the agent runner — treat as 'llm'
  if ((cfg as { type: string }).type === 'remote') {
    cfg.type = 'llm';
  }

  // For LLM agents, env vars fill in fields not set by the config file
  if (cfg.type === 'llm') {
    cfg.provider ??= (process.env.LLM_PROVIDER as AgentConfig['provider']) ?? 'openai';
    cfg.baseUrl ??= process.env.LLM_BASE_URL;
    cfg.apiKey ??= process.env.LLM_API_KEY;
    cfg.model ??= process.env.LLM_MODEL;
  }

  return cfg;
}

async function main() {
  const { power, server, type, lobbyId, planDir } = parseArgs();
  const cfg = resolveAgentConfig(power, type);

  // Step 1: Join lobby to get seat token (unauthenticated client)
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

  // Step 2: Wait for lobby to be playing (autostart may be in progress)
  // LOBBY_READY_TIMEOUT_MS=0 (default) means wait indefinitely
  const trpcClient = createGameClient(server, seatToken);
  const readyTimeoutMs = Number(process.env.LOBBY_READY_TIMEOUT_MS ?? 0);
  const deadline = readyTimeoutMs > 0 ? Date.now() + readyTimeoutMs : Number.POSITIVE_INFINITY;

  while (Date.now() < deadline || deadline === Number.POSITIVE_INFINITY) {
    try {
      await trpcClient.game.getState.query({ lobbyId });
      break; // game is ready
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (deadline !== Number.POSITIVE_INFINITY && Date.now() >= deadline) {
    throw new Error(`Lobby ${lobbyId} never became playable before timeout (${readyTimeoutMs}ms)`);
  }

  // Step 3: Connect agent
  if (cfg.type === 'llm') {
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      console.error(
        `LLM agent for ${power} requires baseUrl, apiKey, model.\n` +
          `Set via config file (powers.${power}) or env vars: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL`,
      );
      process.exit(1);
    }
    const llmConfig = toLLMClientConfig(cfg);
    const llmClient =
      cfg.provider === 'anthropic'
        ? new AnthropicClient(llmConfig)
        : new OpenAICompatibleClient(llmConfig);
    console.log(
      `Starting tool-calling agent for ${power} (${cfg.provider ?? 'openai'}/${cfg.model}), connecting to ${server}...`,
    );
    // connectToolAgent handles everything — joins directly into tool loop
    await connectToolAgent(trpcClient, llmClient, power, lobbyId, planDir);
  } else if (!cfg.type || cfg.type === 'random') {
    console.log(`Starting random agent for ${power}, connecting to ${server}...`);
    await connectRandomAgent(trpcClient, power, lobbyId);
  } else {
    console.error(`Unknown agent type: ${cfg.type}. Valid types: llm, random`);
    process.exit(1);
  }

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
