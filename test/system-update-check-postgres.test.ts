import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,describe,expect,it} from 'vitest';
import {Repository} from '../src/repository.js';
import {PostgresProvisioningStore,ProvisioningService} from '../src/admin/provisioning.js';
const db=process.env.TEST_DATABASE_URL ? new Pool({connectionString:process.env.TEST_DATABASE_URL}) : null;
afterAll(async()=>db?.end());
describe.skipIf(!db)('consulta SO: orden y recuperación',()=>{
  it('no pierde conteos, no duplica avisos y no reabre con reportes viejos',async()=>{
    if(!db)throw Error('db required');
    const repo=new Repository(db);
    const frame=await new ProvisioningService(new PostgresProvisioningStore(db),'naiskosbot').createFrame({name:'Check test'});
    const event=(seq:number,status:string,extra:Record<string,unknown>={})=>({id:randomUUID(),type:'system.updates.checked',
      at:new Date(Date.UTC(2026,10,2,0,seq)).toISOString(),checkSequence:seq,status,...extra});
    const notices=async()=> (await db!.query('SELECT dedupe_key,resolved_at,details FROM naiskos.frame_notifications WHERE frame_id=$1',[frame.frameId])).rows;
    try {
      const initial=event(1,'succeeded',{count:3,rebootRequired:false});
      await repo.applyDeviceEvents(frame.frameId,[initial]);
      const failure=event(2,'failed',{error:'read-only',errorCode:'apt_simulation_failed'});
      const transitions:any[]=[];await repo.applyDeviceEvents(frame.frameId,[failure,failure],transitions);
      expect(transitions).toHaveLength(1);
      expect((await notices()).find(n=>n.dedupe_key==='system-updates-pending').details.count).toBe(3);
      await repo.applyDeviceEvents(frame.frameId,[event(3,'deferred',{error:'busy'})]);
      expect((await notices()).find(n=>n.dedupe_key==='system-update-check-failed').resolved_at).toBeNull();
      const success=event(4,'succeeded',{count:2,rebootRequired:false});
      success.at=initial.at; // Sequence survives a wall-clock correction.
      const recovered:any[]=[];await repo.applyDeviceEvents(frame.frameId,[success],recovered);
      expect(recovered.some(n=>n.status==='resolved')).toBe(true);
      expect((await notices()).find(n=>n.dedupe_key==='system-update-check-failed').resolved_at).not.toBeNull();
      await repo.applyDeviceEvents(frame.frameId,[event(2,'failed',{error:'late old failure'})]);
      expect((await notices()).find(n=>n.dedupe_key==='system-update-check-failed').resolved_at).not.toBeNull();
      expect((await notices()).find(n=>n.dedupe_key==='system-updates-pending').details.count).toBe(2);
      // Concurrent arrivals serialize per frame; the highest sequence wins.
      await Promise.all([
        repo.applyDeviceEvents(frame.frameId,[event(5,'failed',{error:'temporary'})]),
        repo.applyDeviceEvents(frame.frameId,[event(6,'succeeded',{count:0,rebootRequired:false})])]);
      expect((await notices()).every(n=>n.resolved_at!==null)).toBe(true);
      // A later successful maintenance must not be overwritten by delayed count.
      await repo.applyDeviceEvents(frame.frameId,[{id:randomUUID(),type:'system.maintenance.status',at:'2026-11-02T02:00:00Z',
        mode:'security',status:'succeeded',packagesChanged:2,packagesPending:0,rebootRequired:false}]);
      await repo.applyDeviceEvents(frame.frameId,[event(7,'succeeded',{count:9,rebootRequired:false})]);
      expect((await notices()).find(n=>n.dedupe_key==='system-updates-pending').resolved_at).not.toBeNull();
      const latest=event(8,'succeeded',{count:4,rebootRequired:false});latest.at='2026-11-02T03:00:00Z';
      await repo.applyDeviceEvents(frame.frameId,[latest]);
      await repo.applyDeviceEvents(frame.frameId,[{id:randomUUID(),type:'system.maintenance.status',at:'2026-11-02T02:30:00Z',
        mode:'security',status:'succeeded',packagesChanged:1,packagesPending:0,rebootRequired:false}]);
      const pending=(await notices()).find(n=>n.dedupe_key==='system-updates-pending');
      expect(pending.resolved_at).toBeNull();expect(pending.details.count).toBe(4);
    }finally {
      await db.query('DELETE FROM naiskos.device_events WHERE frame_id=$1',[frame.frameId]);
      await db.query('DELETE FROM naiskos.frames WHERE id=$1',[frame.frameId]);
    }
  });
});
