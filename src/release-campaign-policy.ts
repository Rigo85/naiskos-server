export const pendingReleaseStates = ['assigned', 'downloading', 'verified', 'awaiting_window'] as const;
export type ReleaseAction = 'approve' | 'pause' | 'cancel';
export interface CampaignState {
  status: string;
  expiresAt: Date | string;
  assignments?: Array<{ status: string }>;
}

/** Same fleet-wide policy for presentation and commands; no special single-frame case. */
export function releaseFleetState(c: CampaignState, now = new Date()) {
  const rows = c.assignments ?? [];
  const count = (states: readonly string[]) => rows.filter(a => states.includes(a.status)).length;
  const pending = count(pendingReleaseStates);
  const applying = count(['activating']);
  const observing = count(['observing']);
  const installed = count(['installed']);
  const failed = count(['failed']);
  const reverted = count(['rolled_back']);
  const unknown = rows.length - pending - applying - observing - installed - failed - reverted;
  const expired = new Date(c.expiresAt) <= now;
  const actions: ReleaseAction[] = [];
  if (pending > 0 && !expired) {
    if (c.status === 'draft' || c.status === 'paused') actions.push('approve', 'cancel');
    if (c.status === 'approved') actions.push('pause', 'cancel');
  }
  const finished = rows.length > 0 && applying === 0 && observing === 0 && unknown === 0 &&
    (pending === 0 || c.status === 'cancelled');
  return { pending, applying, observing, installed, failed, reverted, unknown, expired, actions, finished };
}
