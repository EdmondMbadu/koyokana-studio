import { isBuiltIn, pickExternalMic } from './recorder';

const dev = (deviceId: string, label: string) =>
  ({ deviceId, label, kind: 'audioinput', groupId: '' }) as MediaDeviceInfo;

describe('pickExternalMic', () => {
  it('prefers a USB mic over webcams, phones and the built-in mic', () => {
    const list = [
      dev('a', '1080P Pro Stream (046d:0894)'),
      dev('b', 'MacBook Air Microphone (Built-in)'),
      dev('c', 'iPhone Microphone'),
      dev('default', 'Default - MacBook Air Microphone (Built-in)'),
      dev('d', 'RØDE NT-USB+ (19f7:0035)'),
    ];
    expect(pickExternalMic(list)?.deviceId).toBe('d');
  });

  it('returns null when only the laptop mic is present', () => {
    expect(pickExternalMic([dev('b', 'MacBook Air Microphone (Built-in)')])).toBeNull();
  });

  it('detects built-in labels', () => {
    expect(isBuiltIn('Default - MacBook Air Microphone (Built-in)')).toBeTrue();
    expect(isBuiltIn('RØDE NT-USB+ (19f7:0035)')).toBeFalse();
  });
});
