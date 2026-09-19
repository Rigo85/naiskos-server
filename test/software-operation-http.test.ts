import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { MaxMindGeoLocator } from '../src/geo-location.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('consulta de software durante una operación', () => {
  it.each(['active', 'race', 'idle'] as const)('responde explícitamente sin borrar staging: %s', async (scenario) => {
    vi.stubEnv('DATABASE_URL', 'postgres://test:test@localhost/test');
    vi.spyOn(MaxMindGeoLocator, 'open').mockResolvedValue(null);
    vi.spyOn(Repository.prototype, 'authenticateFrame').mockResolvedValue({id:'frame'} as never);
    const busy = vi.spyOn(Repository.prototype, 'softwareOperationInProgress');
    if (scenario === 'active') busy.mockResolvedValue(true);
    else busy.mockResolvedValueOnce(false).mockResolvedValue(scenario === 'race');
    const desired = vi.spyOn(Repository.prototype, 'getDesiredSoftware').mockResolvedValue(null);
    const app = await buildApp(loadConfig(), {} as Database);
    try {
      const result = await app.inject({url:'/api/v1/frames/frame/software',headers:{authorization:'Bearer '+ 'a'.repeat(43)}});
      expect(result.statusCode).toBe(scenario === 'idle' ? 204 : 409);
      if (scenario !== 'idle') expect(result.json()).toEqual({code:'software_operation_in_progress'});
      if (scenario === 'active') expect(desired).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
