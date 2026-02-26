import { describe, expect, it } from 'vitest';

import { handleDashboardPageRequest } from '../../src/gateway/dashboard_page.js';

describe('dashboard page route', () => {
  it('serves dashboard html on GET /dashboard', () => {
    const req = {
      method: 'GET',
      url: '/dashboard',
      headers: { host: 'localhost:18789' },
    } as any;

    const state: { status?: number; body?: string; contentType?: string } = {};
    const res = {
      writeHead: (status: number, headers?: Record<string, string>) => {
        state.status = status;
        state.contentType = headers?.['Content-Type'];
      },
      end: (body?: string) => {
        state.body = body;
      },
    } as any;

    const handled = handleDashboardPageRequest(req, res);
    expect(handled).toBe(true);
    expect(state.status).toBe(200);
    expect(state.contentType).toContain('text/html');
    expect(state.body).toContain('Thufir Product Dashboard');
    expect(state.body).toContain('/api/dashboard?');
  });

  it('returns false for non-dashboard paths', () => {
    const req = {
      method: 'GET',
      url: '/not-dashboard',
      headers: { host: 'localhost:18789' },
    } as any;
    const res = {
      writeHead: () => undefined,
      end: () => undefined,
    } as any;

    expect(handleDashboardPageRequest(req, res)).toBe(false);
  });
});
