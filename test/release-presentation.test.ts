import {expect,it} from 'vitest';
import {releaseCampaignPresentation,releaseEventText} from '../src/release-presentation.js';
it('limita mensajes para flotas, prioriza fallos y no inventa progreso',()=>{
 const assignments=Array.from({length:100},(_,i)=>({frameId:String(i),frameName:'Marco '.repeat(20),status:i===99?'failed':'observing',error:'detalle '.repeat(200),updatedAt:'2026-09-16T21:00:00Z'}));
 const p=releaseCampaignPresentation({id:'id',releaseId:'20260916-test',status:'approved',frames:100,installed:0,failed:1,createdAt:new Date(),expiresAt:new Date('2026-09-19T21:00:00Z'),assignments});
 expect(p.text.length).toBeLessThan(4096);expect(p.text).toContain('Falló');expect(p.text).toContain('95 marcos más');
 expect(p.text).toContain('Autorizada no significa instalada');expect(p.text).not.toContain('min restantes');
 expect(releaseEventText({releaseId:'test',status:'rolled_back'},new Date())).toContain('Revertida');
});
