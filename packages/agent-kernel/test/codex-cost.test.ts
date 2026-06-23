import { describe, expect, it, vi } from 'vitest';
import { buildAgentCostEstimate } from '../src/adapters/codex/index.js';

const usage = {
  model: 'known-model',
  inputTokens: 100,
  cachedInputTokens: 50,
  outputTokens: 25,
  reasoningOutputTokens: 5,
};

describe('Codex cost estimates', () => {
  it('preserves token counts without fabricating monetary cost', () => {
    expect(buildAgentCostEstimate(usage)).toEqual({
      inputTokens: 150,
      outputTokens: 25,
    });
  });

  it('uses an injected model-aware pricing provider', () => {
    const estimate = vi.fn(() => 0.123);
    expect(buildAgentCostEstimate(usage, estimate)).toEqual({
      inputTokens: 150,
      outputTokens: 25,
      estimatedCostUsd: 0.123,
    });
    expect(estimate).toHaveBeenCalledWith(usage);
  });

  it('omits monetary cost when the provider does not know the model', () => {
    expect(buildAgentCostEstimate({ ...usage, model: 'unknown' }, () => null)).toEqual({
      inputTokens: 150,
      outputTokens: 25,
    });
  });
});
