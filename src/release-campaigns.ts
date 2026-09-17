import type { PoolClient } from 'pg';
import { releaseFleetState } from './release-campaign-policy.js';

/** Caller holds the campaign row lock, shared by callbacks and device reports. */
export async function reconcileReleaseCampaign(client: PoolClient, id: string): Promise<void> {
  const c = (await client.query<{status:string;active_stage:string;expires_at:Date;release_id:string}>(
    'SELECT status,active_stage,expires_at,release_id FROM naiskos.release_campaigns WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!c) return;
  const assignments = (await client.query<{status:string;stage:string}>(
    'SELECT status,stage FROM naiskos.release_assignments WHERE campaign_id=$1', [id])).rows;
  const fleet = releaseFleetState({status:c.status,expiresAt:c.expires_at,assignments});
  if (fleet.finished && ['approved','paused'].includes(c.status)) {
    await client.query("UPDATE naiskos.release_campaigns SET status='completed',completed_at=now() WHERE id=$1", [id]);
    await client.query("INSERT INTO naiskos.audit_log(action,details) VALUES('release.campaign.completed',$1)",
      [JSON.stringify({campaignId:id,installed:fleet.installed,failed:fleet.failed,reverted:fleet.reverted})]);
    return;
  }
  // A cancelled rollout still receives results from operations already started.
  // Emit the final summary separately from the immediate cancellation acknowledgement.
  if (fleet.finished && c.status === 'cancelled') {
    await client.query(`INSERT INTO naiskos.release_feedback_events(campaign_id,details)
      SELECT $1,$2::jsonb WHERE NOT EXISTS (SELECT 1 FROM naiskos.release_feedback_events
        WHERE campaign_id=$1 AND details->>'finalSummary'='true')`,
      [id,JSON.stringify({releaseId:c.release_id,status:'cancelled',finalSummary:true})]);
    return;
  }
  if (c.status !== 'approved' || fleet.expired) return;
  const stages = ['pilot','ten-percent','remainder'];
  const current = stages.indexOf(c.active_stage);
  // Failures that crossed the threshold already paused the campaign when
  // reported. Otherwise (or after an explicit resume), a terminal cohort must
  // not leave later cohorts silently stuck waiting for an impossible new result.
  if (assignments.some(a => stages.indexOf(a.stage) <= current &&
    !['installed','failed','rolled_back'].includes(a.status))) return;
  const next = stages.slice(current + 1).find(s => assignments.some(a => a.stage === s));
  if (!next) return;
  await client.query('UPDATE naiskos.release_campaigns SET active_stage=$2 WHERE id=$1', [id,next]);
  await client.query("INSERT INTO naiskos.audit_log(action,details) VALUES('release.campaign.stage-advanced',$1)",
    [JSON.stringify({campaignId:id,from:c.active_stage,to:next})]);
}
