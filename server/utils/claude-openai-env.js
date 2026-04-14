/**
 * Shared env helpers for Claude Code OpenAI-compat mode (local claudecode fork).
 */

export function isTruthyEnv(value) {
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
}

export function isClaudeOpenAICompatMode() {
  return isTruthyEnv(process.env.CLAUDE_CODE_USE_OPENAI_COMPAT_API);
}

export function getOpenAICompatBaseUrlTrimmed() {
  const raw =
    process.env.CLAUDE_CODE_OPENAI_BASE_URL?.trim() ||
    process.env.ANTHROPIC_BASE_URL?.trim() ||
    '';
  return raw.replace(/\/+$/, '');
}

export function getEnvDefaultOpenAICompatModel() {
  return (
    process.env.ANTHROPIC_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() ||
    ''
  );
}

export function hasOpenAICompatGatewayCredentials() {
  return Boolean(
    process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      process.env.ANTHROPIC_API_KEY?.trim()
  );
}
