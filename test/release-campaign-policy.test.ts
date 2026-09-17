import {expect,it} from 'vitest';
import {releaseFleetState} from '../src/release-campaign-policy.js';
import {releaseCampaignPresentation,releaseEventText} from '../src/release-presentation.js';
const campaign=(states:string[],status='approved')=>({id:'test',releaseId:'20260917-test',status,
 createdAt:new Date(),expiresAt:new Date('2099-01-01'),frames:states.length,installed:states.filter(s=>s==='installed').length,
 failed:states.filter(s=>['failed','rolled_back'].includes(s)).length,
 assignments:states.map((s,i)=>({frameId:String(i),frameName:`Marco ${i}`,status:s,error:null,updatedAt:'2026-09-17T08:00:00Z'}))});
it.each([1,10,100])('no ofrece acciones para %s marcos aplicando/observando',n=>{
 for(const state of ['activating','observing','installed']) {
  const c=campaign(Array(n).fill(state));
  expect(releaseFleetState(c).actions).toEqual([]);
  expect(releaseCampaignPresentation(c).replyMarkup).toEqual({inline_keyboard:[]});
 }
});
it('comparte acciones para flotas mixtas sin afectar a los que ya comenzaron',()=>{
 const c=campaign(['assigned','downloading','verified','awaiting_window','activating','observing','installed','failed','rolled_back']);
 expect(releaseFleetState(c)).toMatchObject({pending:4,applying:1,observing:1,installed:1,failed:1,reverted:1,actions:['pause','cancel']});
 const p=releaseCampaignPresentation(c);
 expect(p.text).toContain('Acciones sobre 4 pendientes');
 expect(p.replyMarkup).toMatchObject({inline_keyboard:[[{text:'Pausar nuevas instalaciones'},{text:'Cancelar pendientes'}]]});
 expect(releaseFleetState({...c,status:'paused'}).actions).toEqual(['approve','cancel']);
});
it('no ofrece reanudar ni cancelar una campaña pausada que ya terminó',()=>{
 expect(releaseFleetState(campaign(['installed','failed'],'paused'))).toMatchObject({finished:true,actions:[]});
 expect(releaseCampaignPresentation(campaign(['installed','failed'],'paused')).text).toContain('Finalizada con incidencias');
});
it('no interpreta una autorización vencida ni un estado desconocido como éxito',()=>{
 const c=campaign(['assigned','future-state']);
 expect(releaseFleetState({...c,expiresAt:new Date(0)})).toMatchObject({actions:[],finished:false,unknown:1});
 expect(releaseFleetState(campaign([]))).toMatchObject({finished:false,actions:[]});
});
it('explica la espera de una release anterior y conserva el resultado de cancelación',()=>{
 const c=campaign(['awaiting_window']);
 const p=releaseCampaignPresentation({...c,assignments:c.assignments.map(a=>({...a,waitingForRelease:'20260917-before'}))});
 expect(p.text).toContain('Esperando actualización anterior: 20260917-before');
 const cancelled=releaseCampaignPresentation(campaign(['assigned','installed'],'cancelled'));
 expect(cancelled.text).toContain('Finalizada con pendientes cancelados');
 expect(cancelled.replyMarkup).toEqual({inline_keyboard:[]});
 expect(releaseEventText({status:'completed',failed:1,frames:5,installed:4},new Date())).toContain('Finalizada con incidencias');
});
