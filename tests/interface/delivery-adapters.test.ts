import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fetch from 'node-fetch';

import { TelegramAdapter } from '../../src/interface/telegram.js';
import { WhatsAppAdapter } from '../../src/interface/whatsapp.js';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

function response(status: number, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

describe('alert delivery adapters retry policy', () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.mocked(fetch);

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.THUFIR_ALERT_DELIVERY_MAX_ATTEMPTS = '3';
    process.env.THUFIR_ALERT_DELIVERY_RETRY_BASE_MS = '0';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('retries Telegram on 429 and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(response(429, 'too many requests') as any)
      .mockResolvedValueOnce(response(200) as any);

    const adapter = new TelegramAdapter({
      channels: {
        telegram: {
          token: 'token',
          allowedChatIds: [],
          pollingInterval: 5,
        },
      },
    } as any);

    await adapter.sendMessage('123', 'ping');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries Telegram on 5xx up to max attempts and fails terminally', async () => {
    fetchMock.mockResolvedValue(response(503, 'upstream unavailable') as any);

    const adapter = new TelegramAdapter({
      channels: {
        telegram: {
          token: 'token',
          allowedChatIds: [],
          pollingInterval: 5,
        },
      },
    } as any);

    await expect(adapter.sendMessage('123', 'ping')).rejects.toThrow('503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries WhatsApp on 5xx and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(response(500, 'server error') as any)
      .mockResolvedValueOnce(response(200) as any);

    const adapter = new WhatsAppAdapter({
      channels: {
        whatsapp: {
          accessToken: 'token',
          phoneNumberId: 'phone-id',
          verifyToken: 'verify',
          allowedNumbers: [],
        },
      },
    } as any);

    await adapter.sendMessage('15551234567', 'ping');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries WhatsApp on 429 up to max attempts and fails terminally', async () => {
    fetchMock.mockResolvedValue(response(429, 'rate limited') as any);

    const adapter = new WhatsAppAdapter({
      channels: {
        whatsapp: {
          accessToken: 'token',
          phoneNumberId: 'phone-id',
          verifyToken: 'verify',
          allowedNumbers: [],
        },
      },
    } as any);

    await expect(adapter.sendMessage('15551234567', 'ping')).rejects.toThrow('429');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
