import { invoke } from '@tauri-apps/api/core';

export type ApiStyle = 'openai' | 'anthropic';

export interface HeaderEntry {
  name: string;
  value: string;
}

/** Mirrors `AiSettings` in src-tauri/src/ai.rs (camelCase over the IPC bridge). */
export interface AiSettings {
  enabled: boolean;
  apiStyle: ApiStyle;
  /** e.g. https://llm.mycorp.local/v1 — "/chat/completions" (or "/messages") is appended unless already present. */
  baseUrl: string;
  model: string;
  /** Header that carries the API key, e.g. "Authorization" or "api-key". Empty = don't send the key. */
  authHeader: string;
  /** Prefix placed before the key, e.g. "Bearer ". */
  authPrefix: string;
  headers: HeaderEntry[];
  verifySsl: boolean;
  /** Optional explicit proxy, e.g. http://proxy:8080. Empty = use system env (HTTPS_PROXY) or none. */
  proxy: string;
  timeoutSecs: number;
  temperature: number;
  maxTokens: number;
}

export interface SettingsView {
  settings: AiSettings;
  hasApiKey: boolean;
}

export const getSettings = () => invoke<SettingsView>('get_settings');

/** apiKey: undefined = keep existing, '' = delete, otherwise replace. */
export const saveSettings = (settings: AiSettings, apiKey?: string) =>
  invoke<SettingsView>('save_settings', { settings, apiKey: apiKey ?? null });

export const testAi = (settings: AiSettings, apiKey?: string) =>
  invoke<string>('test_ai', { settings, apiKey: apiKey ?? null });

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const aiChat = (messages: ChatMsg[]) => invoke<string>('ai_chat', { messages });
