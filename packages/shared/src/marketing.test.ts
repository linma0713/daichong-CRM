import { describe, expect, it } from 'vitest';
import { CHANNEL_PLATFORM_VALUES, channelPlatformLabel, roi } from './marketing';

describe('marketing', () => {
  it('roi', () => {
    expect(roi(30000, 10000)).toBe(2);
    expect(roi(5000, 10000)).toBe(-0.5);
    expect(roi(5000, 0)).toBeNull();
  });
  it('platform labels', () => {
    expect(channelPlatformLabel('xiaohongshu')).toBe('小红书');
    expect(channelPlatformLabel('unknown')).toBe('unknown');
    expect(new Set(CHANNEL_PLATFORM_VALUES).size).toBe(CHANNEL_PLATFORM_VALUES.length);
  });
});
