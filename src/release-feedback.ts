import { createHash } from 'node:crypto';
import { Database, transaction } from './db.js';
import { Repository } from './repository.js';
import type { TelegramTransport } from './telegram.js';
import { releaseCampaignPresentation, releaseEventText } from './release-presentation.js';

type Transport=Pick<TelegramTransport,'sendMessage'|'editMessageText'>;
interface Delivery {message_id:string|null;fingerprint:string|null;attempts:number;available_at:Date;delivered_at:Date|null}
export class ReleaseFeedback {
 constructor(private db:Database,private telegram:Transport,private admins:Set<string>) {}

 async show(chatId:number|string,campaignId:string,existingMessageId?:number):Promise<void> {
  await this.deliver(String(chatId),campaignId,'status',existingMessageId);
 }

 async runOnce():Promise<void> {
  // Recipients are persisted before delivery, so failures and process restarts do not lose notices.
  await this.db.query(`INSERT INTO naiskos.release_feedback_deliveries(campaign_id,chat_id,delivery_key)
    SELECT e.campaign_id,chat,'event:'||e.id FROM naiskos.release_feedback_events e
    CROSS JOIN unnest($1::text[]) chat ON CONFLICT DO NOTHING`,[[...this.admins]]);
  const events=await this.db.query<{campaign_id:string;chat_id:string;delivery_key:string}>(
   `SELECT campaign_id,chat_id,delivery_key FROM naiskos.release_feedback_deliveries
    WHERE delivery_key<>'status' AND delivered_at IS NULL AND available_at<=now()
    ORDER BY available_at,delivery_key LIMIT 10`);
  for(const e of events.rows) {
   if(this.admins.has(e.chat_id)) await this.deliver(e.chat_id,e.campaign_id,e.delivery_key);
  }
  const subscriptions=await this.db.query<{campaign_id:string;chat_id:string}>(
   `SELECT campaign_id,chat_id FROM naiskos.release_feedback_deliveries
    WHERE delivery_key='status' AND available_at<=now() ORDER BY campaign_id,chat_id`);
  for(const s of subscriptions.rows) {
   if(this.admins.has(s.chat_id)) await this.show(s.chat_id,s.campaign_id);
  }
 }

 private async deliver(chatId:string,campaignId:string,key:string,existingMessageId?:number):Promise<void> {
  await transaction(this.db,async client=>{
   // One sender per campaign/chat, including /versiones, callbacks and scheduled refresh.
   const locked=await client.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`release-feedback:${chatId}:${campaignId}`]);
   if(!locked.rows[0]?.ok) return;
   await client.query(`INSERT INTO naiskos.release_feedback_deliveries(campaign_id,chat_id,delivery_key,message_id)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[campaignId,chatId,key,existingMessageId ?? null]);
   const row=(await client.query<Delivery>(`SELECT * FROM naiskos.release_feedback_deliveries
     WHERE campaign_id=$1 AND chat_id=$2 AND delivery_key=$3 FOR UPDATE`,[campaignId,chatId,key])).rows[0]!;
   if(row.available_at>new Date() || (key!=='status' && row.delivered_at)) return;
   let text:string; let markup:object|undefined;
   if(key==='status') {
    const campaign=(await new Repository(this.db).listReleaseCampaigns(campaignId,client))[0];
    if(!campaign) return;
    const p=releaseCampaignPresentation(campaign);text=p.text;markup=p.replyMarkup;
   } else {
    const event=(await client.query<{details:Record<string,unknown>;created_at:Date}>(
     'SELECT details,created_at FROM naiskos.release_feedback_events WHERE id=$1 AND campaign_id=$2',
     [key.slice(6),campaignId])).rows[0];
    if(!event) throw Error('Evento de release no encontrado');
    text=releaseEventText(event.details,event.created_at);
   }
   const fingerprint=createHash('sha256').update(JSON.stringify([text,markup])).digest('hex');
   if(key==='status' && row.fingerprint===fingerprint) return;
   let messageId=row.message_id;
   try {
    if(messageId && key==='status') {
     try { await this.telegram.editMessageText(chatId,Number(messageId),text,markup); }
     catch(error) {
      const reason=error instanceof Error?error.message:String(error);
      if(/message is not modified/i.test(reason)) { /* previous edit succeeded before acknowledgement */ }
      else if(/message to edit not found|message can't be edited/i.test(reason)) messageId=null;
      else throw error;
     }
    }
    if(!messageId) {
     const result=await this.telegram.sendMessage(chatId,text,markup) as {message_id?:number};
     if(!Number.isSafeInteger(result?.message_id)) throw Error('Telegram no confirmó message_id');
     messageId=String(result.message_id);
    }
    await client.query(`UPDATE naiskos.release_feedback_deliveries SET message_id=$4,fingerprint=$5,
     delivered_at=now(),attempts=0,last_error=NULL WHERE campaign_id=$1 AND chat_id=$2 AND delivery_key=$3`,
     [campaignId,chatId,key,messageId,fingerprint]);
   } catch(error) {
    const retry=Number((error as {retryAfterSeconds?:number})?.retryAfterSeconds);
    const delay=retry>0?Math.min(retry,3600):Math.min(3600,5*2**Math.min(row.attempts+1,10));
    await client.query(`UPDATE naiskos.release_feedback_deliveries SET attempts=attempts+1,
      available_at=now()+make_interval(secs=>$4),last_error=$5
      WHERE campaign_id=$1 AND chat_id=$2 AND delivery_key=$3`,
      [campaignId,chatId,key,delay,(error instanceof Error?error.message:String(error)).slice(0,1000)]);
    // Respect chat-level throttling across canonical updates and result notices.
    if(retry>0) await client.query(`UPDATE naiskos.release_feedback_deliveries SET
     available_at=GREATEST(available_at,now()+make_interval(secs=>$2)) WHERE chat_id=$1`,[chatId,delay]);
   }
  });
 }
}
