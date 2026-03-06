import 'dotenv/config';

import { Power } from '../../engine/types.js';
import { AnthropicClient } from '../llm/anthropic-client.js';
import { LLMAgent } from '../llm/llm-agent.js';
import { LLMClient, OpenAICompatibleClient } from '../llm/llm-client.js';
import { RandomAgent } from '../random.js';
import { createGameClient } from './client.js';
import { connectRemoteAgent } from './remote-adapter.js';

const VALID_POWERS = new Set(Object.values(Power));

function parseArgs(): { power: Power; server: string; type: string } {
  const args = process.argv.slice(2);
  let power: string | undefined;
  let server = process.env.GAME_SERVER ?? 'http://localhost:3000/trpc';
  let type = 'random';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--power' && args[i + 1]) {
      power = args[++i];
    } else if (args[i] === '--server' && args[i + 1]) {
      server = args[++i];
    } else if (args[i] === '--type' && args[i + 1]) {
      type = args[++i];
    }
  }

  if (!power || !VALID_POWERS.has(power as Power)) {
    console.error(
      `Usage: node run.js --power <Power> [--server <url>] [--type random|llm]\n` +
        `  Valid powers: ${[...VALID_POWERS].join(', ')}`,
    );
    process.exit(1);
  }

  return { power: power as Power, server, type };
}

async function main() {
  const { power, server, type } = parseArgs();

  // Create agent implementation
  let agent;
  if (type === 'llm') {
    const provider = process.env.LLM_PROVIDER ?? 'openai';
    const baseUrl = process.env.LLM_BASE_URL;
    const apiKey = process.env.LLM_API_KEY;
    const model = process.env.LLM_MODEL;

    if (!baseUrl || !apiKey || !model) {
      console.error('LLM agent requires env vars: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL');
      process.exit(1);
    }

    const client: LLMClient =
      provider === 'anthropic'
        ? new AnthropicClient({ baseUrl, apiKey, model })
        : new OpenAICompatibleClient({ baseUrl, apiKey, model });

    agent = new LLMAgent(power, client);
  } else {
    agent = new RandomAgent(power);
  }

  console.log(`Starting ${type} agent for ${power}, connecting to ${server}...`);

  const trpcClient = createGameClient(server);
  await connectRemoteAgent(agent, trpcClient);

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
