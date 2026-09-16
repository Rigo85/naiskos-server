import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,describe,expect,it} from 'vitest';
import {PostgresProvisioningStore,ProvisioningService} from '../src/admin/provisioning.js';
import {Repository} from '../src/repository.js';
import {ReleaseFeedback} from '../src/release-feedback.js';
import {TelegramApiError} from '../src/telegram.js';
const db=process.env.TEST_DATABASE_URL?new Pool({connectionString:process.env.TEST_DATABASE_URL}):null;
afterAll(async()=>db?.end());
describe.skipIf(!db)('feedback de releases durable',()=>{
 it('conserva estado, resuelve nota transitoria, serializa refrescos, reintenta y deduplica resultados',async()=>{
  if(!db) throw Error('database required');
  const repo=new Repository(db);
  const frame=await new ProvisioningService(new PostgresProvisioningStore(db),'naiskosbot').createFrame({name:'Feedback pilot'});
  const campaign=randomUUID(),release=`20260916-feedback-${randomUUID().slice(0,8)}`;
  const messages:string[]=[],edits:string[]=[];
  let sendFailure:Error|null=null,editFailure:Error|null=null;
  const transport={
   async sendMessage(_chat:unknown,text:string){if(sendFailure)throw sendFailure;messages.push(text);return {message_id:messages.length};},
   async editMessageText(_chat:unknown,_id:number,text:string){if(editFailure)throw editFailure;edits.push(text);},
  };
  const feedback=new ReleaseFeedback(db,transport,new Set(['99']));
  const event=(status:string,extra={})=>({id:randomUUID(),type:'software.release.status',at:new Date().toISOString(),campaignId:campaign,releaseId:release,status,...extra});
  try {
   await db.query(`INSERT INTO naiskos.software_releases(release_id,manifest,manifest_path,signature_path,archive_path,archive_size_bytes,archive_sha256)
    VALUES($1,'{}','m','s','a',1,$2)`,[release,'a'.repeat(64)]);
   await db.query(`INSERT INTO naiskos.release_campaigns(id,release_id,status,expires_at) VALUES($1,$2,'approved',now()+interval '1 day')`,[campaign,release]);
   await db.query('INSERT INTO naiskos.release_assignments(campaign_id,frame_id) VALUES($1,$2)',[campaign,frame.frameId]);
   await Promise.all([feedback.show('99',campaign),feedback.show('99',campaign)]);
   expect(messages).toHaveLength(1);
   await repo.applyDeviceEvents(frame.frameId,[event('observing',{error:'Salud pendiente'})]);
   await feedback.show('99',campaign);
   expect(edits.at(-1)).toContain('Nota del último reporte: Salud pendiente');
   await repo.applyDeviceEvents(frame.frameId,[event('observing',{healthConfirmed:true}),event('observing',{error:'Nota vieja'})]);
   const row=(await repo.listReleaseCampaigns(campaign))[0]!;
   expect(row.assignments![0]).toMatchObject({error:null,healthConfirmed:true});
   await feedback.show('99',campaign);
   expect(edits.at(-1)).toContain('Salud funcional confirmada');
   expect(edits.at(-1)).not.toContain('Nota vieja');
   const before=edits.length;await feedback.show('99',campaign);expect(edits).toHaveLength(before);
   // A lost edit acknowledgement is safe to retry on the same message ID.
   editFailure=new Error('Bad Request: message is not modified');
   await db.query(`UPDATE naiskos.release_feedback_deliveries SET fingerprint=NULL WHERE campaign_id=$1`,[campaign]);
   await feedback.show('99',campaign);editFailure=null;expect(messages).toHaveLength(1);
   // Deleted canonical message: replace once and retain the new binding.
   editFailure=new Error('Bad Request: message to edit not found');
   await db.query(`UPDATE naiskos.release_feedback_deliveries SET fingerprint=NULL WHERE campaign_id=$1`,[campaign]);
   await feedback.show('99',campaign);editFailure=null;expect(messages).toHaveLength(2);
   const failed=event('failed',{error:'Prueba de fallo'});
   await repo.applyDeviceEvents(frame.frameId,[failed,failed,event('failed'),event('observing',{healthConfirmed:true})]);
   expect((await repo.listReleaseCampaigns(campaign))[0]?.assignments![0]?.status).toBe('failed');
   const events=(await db.query('SELECT * FROM naiskos.release_feedback_events WHERE campaign_id=$1 ORDER BY id',[campaign])).rows;
   expect(events.map(e=>e.details.status)).toEqual(['failed','paused']);
   sendFailure=new TelegramApiError('Too many requests',120);
   await feedback.runOnce();
   const pending=(await db.query(`SELECT * FROM naiskos.release_feedback_deliveries WHERE campaign_id=$1 AND delivery_key<>'status'`,[campaign])).rows;
   expect(pending).toHaveLength(2);expect(pending.every(r=>r.delivered_at===null)).toBe(true);
   expect(pending.some(r=>r.attempts===1)).toBe(true);
   sendFailure=null;
   await db.query(`UPDATE naiskos.release_feedback_deliveries SET available_at=now() WHERE campaign_id=$1`,[campaign]);
   await new ReleaseFeedback(db,transport,new Set(['99'])).runOnce();
   expect(messages.filter(m=>m.includes('Naiskos · Falló'))).toHaveLength(1);
   expect(messages.filter(m=>m.includes('pausada con fallos'))).toHaveLength(1);
   const count=messages.length;await feedback.runOnce();expect(messages).toHaveLength(count);
   await repo.transitionReleaseCampaign(campaign,'cancel','99');await feedback.runOnce();
   expect(edits.at(-1)).toContain('No desinstala lo aplicado');
   expect(messages.at(-1)).toContain('Cancelar no desinstala');
   // Rollbacks don't leak transactional events.
   const client=await db.connect();
   try {await client.query('BEGIN');await client.query(`UPDATE naiskos.release_campaigns SET status='completed' WHERE id=$1`,[campaign]);await client.query('ROLLBACK');}
   finally {client.release();}
   expect((await db.query(`SELECT 1 FROM naiskos.release_feedback_events WHERE campaign_id=$1 AND details->>'status'='completed'`,[campaign])).rowCount).toBe(0);
  } finally {
   await db.query("DELETE FROM naiskos.audit_log WHERE frame_id=$1 OR details->>'campaignId'=$2",[frame.frameId,campaign]);
   await db.query('DELETE FROM naiskos.release_campaigns WHERE id=$1',[campaign]);
   await db.query('DELETE FROM naiskos.software_releases WHERE release_id=$1',[release]);
   await db.query('DELETE FROM naiskos.frames WHERE id=$1',[frame.frameId]);
  }
 });
});
