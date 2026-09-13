import { beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_KEY, deviceLabelFromUA, getDevice } from './device';

describe('device identity', () => {
  beforeEach(() => localStorage.clear());

  it('labels common user agents', () => {
    expect(
      deviceLabelFromUA(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      ),
    ).toBe('Chrome · macOS');
    expect(
      deviceLabelFromUA(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari · iPhone');
    expect(
      deviceLabelFromUA(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
      ),
    ).toBe('Firefox · Windows');
    expect(
      deviceLabelFromUA(
        'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0',
      ),
    ).toBe('Edge · Windows');
    expect(deviceLabelFromUA('')).toBe('Browser · device');
  });

  it('keeps one id per browser', () => {
    const a = getDevice();
    const b = getDevice();
    expect(a.id).toBe(b.id);
    expect(a.id.length).toBeGreaterThan(8);
    expect(JSON.parse(localStorage.getItem(DEVICE_KEY)!).id).toBe(a.id);
  });
});
