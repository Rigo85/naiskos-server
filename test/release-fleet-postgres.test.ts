import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,describe,expect,it} from 'vitest';
import {Repository} from '../src/repository.js';
import {ReleaseFeedback} from '../src/release-feedback.js';
const db=process.env.TEST_DATABASE_URL?new Pool({connectionString:process.env.TEST_DATABASE_URL,max:4}):null;
afterAll(async()=>db?.end());
async function fleet(states:string[],run:(f:{repo:Repository;id:string;release:string;frames:string[];event:(i:number,s:string)=>Promise<unknown>})=>Promise<void>) {
 if(!db) throw Error('database required');
 const id=randomUUID(),release=`20260917-fleet-${randomUUID()}`,frames=states.map(()=>randomUUID());
 const repo=new Repository(db);
 try {
  await db.query(`INSERT INTO naiskos.software_releases(release_id,manifest,manifest_path,signature_path,archive_path,archive_size_bytes,archive_sha256)
    VALUES($1,'{}','m','s','a',1,$2)`,[release,'a'.repeat(64)]);
  await db.query(`INSERT INTO naiskos.release_campaigns(id,release_id,status,expires_at) VALUES($1,$2,'approved',now()+interval '1 day')`,[id,release]);
  for(const [i,frame] of frames.entries()) {
   await db.query('INSERT INTO naiskos.frames(id,name) VALUES($1,$2)',[frame,`Fleet ${i}`]);
   await db.query('INSERT INTO naiskos.release_assignments(campaign_id,frame_id,status) VALUES($1,$2,$3)',[id,frame,states[i]]);
  }
  await run({repo,id,release,frames,event:(i,status)=>repo.applyDeviceEvents(frames[i]!,[{id:randomUUID(),type:'software.release.status',at:new Date().toISOString(),campaignId:id,releaseId:release,status}])});
 } finally {
  await db.query("DELETE FROM naiskos.audit_log WHERE frame_id=ANY($1::uuid[]) OR details->>'campaignId'=$2",[frames,id]);
  await db.query('DELETE FROM naiskos.release_campaigns WHERE id=$1',[id]);
  await db.query('DELETE FROM naiskos.software_releases WHERE release_id=$1',[release]);
  await db.query('DELETE FROM naiskos.frames WHERE id=ANY($1::uuid[])',[frames]);
 }
}
describe.skipIf(!db)('coordinación de flotas y Telegram',()=>{
 it('distingue una operación iniciada de ausencia/cancelación sin cambiar autorización',async()=>{
  await fleet(['activating','observing','assigned','installed','failed'],async({repo,id,frames})=>{
   for(const [i,frame] of frames.entries()) expect(await repo.softwareOperationInProgress(frame)).toBe(i<2);
   await db!.query("UPDATE naiskos.release_campaigns SET status='cancelled' WHERE id=$1",[id]);
   expect(await repo.softwareOperationInProgress(frames[0]!)).toBe(true);
   expect(await repo.getDesiredSoftware(frames[0]!)).toBeNull();
   expect(await repo.getDesiredSoftware(frames[2]!)).toBeNull();
  });
 });
 it('rechaza botones viejos para muchos marcos observando, actualiza el mismo mensaje y quita su teclado',async()=>{
  await fleet(Array(10).fill('assigned'),async({repo,id})=>{
   const sends:unknown[]=[],edits:unknown[]=[];
   const feedback=new ReleaseFeedback(db!,{async sendMessage(_c,t,m){sends.push({t,m});return {message_id:700};},
     async editMessageText(_c,i,t,m){edits.push({i,t,m});}},new Set(['99']));
   await feedback.show('99',id);
   await db!.query("UPDATE naiskos.release_assignments SET status='observing',health_confirmed=true WHERE campaign_id=$1",[id]);
   expect(await repo.transitionReleaseCampaign(id,'pause','99')).toBe(false);
   expect(await repo.transitionReleaseCampaign(id,'cancel','99')).toBe(false);
   await feedback.runOnce();
   expect(sends).toHaveLength(1);
   expect(edits.at(-1)).toMatchObject({i:700,m:{inline_keyboard:[]}});
   expect((edits.at(-1) as {t:string}).t).toContain('Actualización aplicada; verificación en curso');
  });
 });
 it('cierra una campaña pausada al recibir todos los resultados, incluso con fallos',async()=>{
  await fleet(['observing','observing'],async({repo,id,event})=>{
   await db!.query("UPDATE naiskos.release_campaigns SET status='paused' WHERE id=$1",[id]);
   await Promise.all([event(0,'installed'),event(1,'failed')]);
   expect((await repo.listReleaseCampaigns(id))[0]).toMatchObject({status:'completed',installed:1,failed:1});
   expect(await repo.transitionReleaseCampaign(id,'approve','99')).toBe(false);
   await repo.reconcileReleaseCampaigns();
   expect((await db!.query("SELECT count(*)::int n FROM naiskos.release_feedback_events WHERE campaign_id=$1 AND details->>'status'='completed'",[id])).rows[0].n).toBe(1);
  });
 });
 it('reanudar reevalúa los grupos sin esperar otro reporte y el reconciliador recupera cierres',async()=>{
  await fleet(['installed','assigned','assigned'],async({repo,id,frames})=>{
   await db!.query("UPDATE naiskos.release_assignments SET stage='ten-percent' WHERE campaign_id=$1 AND frame_id=$2",[id,frames[1]]);
   await db!.query("UPDATE naiskos.release_assignments SET stage='remainder' WHERE campaign_id=$1 AND frame_id=$2",[id,frames[2]]);
   await db!.query("UPDATE naiskos.release_campaigns SET status='paused' WHERE id=$1",[id]);
   expect(await repo.transitionReleaseCampaign(id,'approve','99')).toBe(true);
   expect((await db!.query('SELECT active_stage FROM naiskos.release_campaigns WHERE id=$1',[id])).rows[0].active_stage).toBe('ten-percent');
   expect(await repo.getDesiredSoftware(frames[2]!)).toBeNull();
   await db!.query("UPDATE naiskos.release_assignments SET status='installed' WHERE campaign_id=$1",[id]);
   await repo.reconcileReleaseCampaigns();
   expect((await repo.listReleaseCampaigns(id))[0]?.status).toBe('completed');
  });
 });
 it('vencer no cancela una observación y cancelar pendientes conserva reportes tardíos',async()=>{
  await fleet(['observing','observing'],async({repo,id})=>{
   await db!.query("UPDATE naiskos.release_campaigns SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[id]);
   expect((await repo.expireReleaseCampaigns()).some(c=>c.campaignId===id)).toBe(false);
   expect((await repo.listReleaseCampaigns(id))[0]?.status).toBe('approved');
  });
  await fleet(['assigned','observing'],async({repo,id,event})=>{
   expect(await repo.transitionReleaseCampaign(id,'cancel','99')).toBe(true);
   await event(1,'installed');
   expect((await repo.listReleaseCampaigns(id))[0]).toMatchObject({status:'cancelled',installed:1});
   expect(await repo.transitionReleaseCampaign(id,'approve','99')).toBe(false);
   await event(1,'observing');
   expect((await db!.query("SELECT count(*)::int n FROM naiskos.release_feedback_events WHERE campaign_id=$1 AND details->>'finalSummary'='true'",[id])).rows[0].n).toBe(1);
  });
 });
 it('serializa la carrera entre pausa y el último reporte sin dejar campañas imposibles',async()=>{
  await fleet(['assigned','installed'],async({repo,id,event})=>{
   await Promise.all([repo.transitionReleaseCampaign(id,'pause','99'),event(0,'installed')]);
   expect((await repo.listReleaseCampaigns(id))[0]?.status).toBe('completed');
   expect(await repo.transitionReleaseCampaign(id,'cancel','99')).toBe(false);
  });
 });
 it('permite llegar un día después sin repetir instalaciones y conserva resultados al vencer',async()=>{
  await fleet(['installed','observing','assigned'],async({repo,id,frames,event})=>{
   await db!.query("UPDATE naiskos.release_campaigns SET created_at=now()-interval '1 day',approved_at=now()-interval '1 day' WHERE id=$1",[id]);
   await db!.query("UPDATE naiskos.release_assignments SET assigned_at=now()-interval '1 day' WHERE campaign_id=$1",[id]);
   expect(await repo.getDesiredSoftware(frames[0]!)).toBeNull();
   expect(await repo.getDesiredSoftware(frames[2]!)).toMatchObject({campaignId:id});
   await db!.query("UPDATE naiskos.release_campaigns SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[id]);
   expect((await repo.expireReleaseCampaigns()).some(c=>c.campaignId===id)).toBe(true);
   expect(await repo.getDesiredSoftware(frames[2]!)).toBeNull();
   await event(1,'installed');
   const c=(await repo.listReleaseCampaigns(id))[0]!;
   expect(c).toMatchObject({status:'cancelled',installed:2,failed:0});
   expect(c.assignments?.find(a=>a.frameId===frames[2])?.status).toBe('assigned');
  });
 });
 it('retiene la siguiente cohorte ante fallos y sólo la libera tras reanudación explícita',async()=>{
  await fleet(['observing','assigned'],async({repo,id,frames,event})=>{
   await db!.query("UPDATE naiskos.release_assignments SET stage='remainder' WHERE campaign_id=$1 AND frame_id=$2",[id,frames[1]]);
   await event(0,'failed');
   expect((await repo.listReleaseCampaigns(id))[0]?.status).toBe('paused');
   expect(await repo.getDesiredSoftware(frames[1]!)).toBeNull();
   expect(await repo.transitionReleaseCampaign(id,'approve','99')).toBe(true);
   expect(await repo.getDesiredSoftware(frames[1]!)).toMatchObject({campaignId:id});
   await event(1,'installed');
   expect((await repo.listReleaseCampaigns(id))[0]).toMatchObject({status:'completed',installed:1,failed:1});
  });
 });
});
