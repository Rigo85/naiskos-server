import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { recoveryText, validRecoveryEvent } from '../src/recovery-notifications.js';
it('valida estados y conserva identidad/fecha del incidente en el aviso', () => {
  const event = { incidentId: randomUUID(), bootId: randomUUID(), sequence: 1,
    status: 'reboot-requested', reason: 'Cierre agotado', at: '2026-10-11T02:00:00Z' };
  expect(validRecoveryEvent(event)).toBe(true);
  expect(recoveryText('Marco', event)).toContain(event.incidentId);
  expect(recoveryText('Marco', event)).toContain('solicitado');
  expect(validRecoveryEvent({ ...event, status: 'toString' })).toBe(false);
  expect(validRecoveryEvent({ ...event, sequence: -1 })).toBe(false);
  expect(validRecoveryEvent({ ...event, bootId: 'bad' })).toBe(false);
  expect(validRecoveryEvent({ ...event, at: 'invalid' })).toBe(false);
});
