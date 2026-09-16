import type { ReleaseCampaignSummary } from './repository.js';

const labels: Record<string,string> = {
 draft:'Borrador',approved:'Autorizada',paused:'Pausada',cancelled:'Cancelada',completed:'Completada',
 assigned:'Pendiente de descarga',downloading:'Descargando',verified:'Paquete verificado',
 awaiting_window:'Esperando ventana',activating:'Aplicando',observing:'En observación',
 installed:'Instalada y verificada',failed:'Falló',rolled_back:'Revertida',
};
export const releaseLabel = (status: string) => labels[status] ?? status;
export function releaseTime(value: Date | string, timezone='America/Lima'): string {
 return new Intl.DateTimeFormat('es-PE',{timeZone:timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(value));
}
export function releaseCampaignPresentation(c: ReleaseCampaignSummary): {text:string;replyMarkup:object} {
 const tz=c.timezone ?? 'America/Lima';
 const buttons=c.status==='draft' ? [
  {text:'Aprobar campaña',callback_data:`release-approve:${c.id}`},
  {text:'Cancelar',callback_data:`release-cancel:${c.id}`}]
  : c.status==='approved' || c.status==='paused' ? [
   {text:c.status==='paused'?'Reanudar':'Pausar',callback_data:`release-${c.status==='paused'?'approve':'pause'}:${c.id}`},
   {text:'Cancelar',callback_data:`release-cancel:${c.id}`}]:[];
 const lines=[c.releaseId,`Campaña: ${releaseLabel(c.status)}`,
  `Vence: ${releaseTime(c.expiresAt,tz)} (${tz})`,
  `Marcos: ${c.frames} · verificados: ${c.installed} · fallos/reversiones: ${c.failed}`];
 if(c.status==='approved') lines.push('Autorizada no significa instalada.');
 if(c.status==='cancelled') lines.push('No autoriza nuevas activaciones. No desinstala lo aplicado ni interrumpe una operación ya iniciada.');
 const assignments=c.assignments ?? [];
 const counts=new Map<string,number>();
 for(const a of assignments) counts.set(a.status,(counts.get(a.status) ?? 0)+1);
 if(assignments.length>5) lines.push([...counts].map(([s,n])=>`${releaseLabel(s)}: ${n}`).join(' · '));
 // Prioritize failures instead of hiding them behind the first alphabetical frames.
 const ordered=[...assignments].sort((a,b)=>Number(['failed','rolled_back'].includes(b.status))-Number(['failed','rolled_back'].includes(a.status)));
 for(const a of ordered.slice(0,5)) {
  lines.push('',`${a.frameName.slice(0,80)}: ${releaseLabel(a.status)}`,
   `Último reporte: ${releaseTime(a.updatedAt,tz)}`);
  if(a.status==='observing') lines.push(`Observación requerida: ${c.observeMinutes ?? 60} min efectivos; aún no finalizada.`);
  if(a.status==='observing' && a.healthConfirmed) lines.push('Salud funcional confirmada durante la observación.');
  if(a.error) lines.push(`${['failed','rolled_back'].includes(a.status)?'Causa':'Nota del último reporte'}: ${a.error.slice(0,300)}`);
 }
 if(assignments.length>5) lines.push(`… y ${assignments.length-5} marcos más.`);
 return {text:lines.join('\n'),replyMarkup:{inline_keyboard:buttons.length?[buttons]:[]}};
}
export function releaseEventText(details: Record<string,unknown>, at: Date|string): string {
 const status=String(details.status);
 const heading=details.expired ? 'Campaña vencida' : status==='paused' && details.hasFailures ? 'Campaña pausada con fallos reportados' : releaseLabel(status);
 return [`Naiskos · ${heading}`,String(details.releaseId),
  ...(details.frameName?[`Marco: ${String(details.frameName).slice(0,100)}`]:[]),
  ...(details.error?[`Causa: ${String(details.error).slice(0,1000)}`]:[]),
  ...(status==='cancelled'?['Cancelar no desinstala lo aplicado ni interrumpe una operación ya iniciada.']:[]),
  `${releaseTime(at)} (America/Lima)`].join('\n');
}
