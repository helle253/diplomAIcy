import { readFileSync } from 'fs';
import { resolve } from 'path';

import { Power } from '../../engine/types.js';
import { logger } from '../../util/logger.js';
import { LLMClientConfig } from './llm-client.js';

export interface AgentConfig {
  type: 'random' | 'llm' | 'remote';
  provider?: 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GameConfig {
  defaultAgent: AgentConfig;
  powers?: Partial<Record<Power, Partial<AgentConfig>>>;
}

function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      logger.warn(`Environment variable ${name} is not set`);
      return '';
    }
    return envVal;
  });
}

function interpolateConfig(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = interpolateEnvVars(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = interpolateConfig(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(configPath?: string): GameConfig {
  const path =
    configPath ?? resolve(process.cwd(), process.env.DIPLOMAICY_CONFIG ?? 'diplomaicy.config.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    // No config file — fall back to all random
    return { defaultAgent: { type: 'random' } };
  }

  const parsed = interpolateConfig(JSON.parse(raw) as Record<string, unknown>) as unknown;
  return parsed as GameConfig;
}

export function getAgentConfig(config: GameConfig, power: Power): AgentConfig {
  const powerOverride = config.powers?.[power];
  if (!powerOverride) return config.defaultAgent;
  return { ...config.defaultAgent, ...powerOverride };
}

export function toLLMClientConfig(agent: AgentConfig): LLMClientConfig {
  if (!agent.baseUrl) throw new Error('LLM agent requires baseUrl');
  if (!agent.apiKey) throw new Error('LLM agent requires apiKey');
  if (!agent.model) throw new Error('LLM agent requires model');

  return {
    baseUrl: agent.baseUrl,
    apiKey: agent.apiKey,
    model: agent.model,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
  };
}
