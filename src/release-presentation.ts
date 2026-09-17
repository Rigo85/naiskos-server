import type { ReleaseCampaignSummary } from './repository.js';
import { releaseFleetState, pendingReleaseStates } from './release-campaign-policy.js';

const labels: Record<string,string> = {
 draft:'Borrador',approved:'Autorizada',paused:'Pausada',cancelled:'Cancelada',completed:'Completada',
 assigned:'Pendiente de descarga',downloading:'Descargando',verified:'Paquete verificado',
 awaiting_window:'Descargada; pendiente de activación',activating:'Aplicando',observing:'Aplicada; verificación en curso',
 installed:'Instalada y verificada',failed:'Falló',rolled_back:'Revertida',
};
export const releaseLabel = (status: string) => labels[status] ?? status;
export function releaseTime(value: Date | string, timezone='America/Lima'): string {
 return new Intl.DateTimeFormat('es-PE',{timeZone:timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(value));
}
export function releaseCampaignPresentation(c: ReleaseCampaignSummary): {text:string;replyMarkup:object} {
 const tz=c.timezone ?? 'America/Lima';
 const fleet=releaseFleetState(c);
 const names={approve:c.status==='draft'?'Aprobar campaña':'Reanudar pendientes',pause:'Pausar nuevas instalaciones',cancel:'Cancelar pendientes'};
 const buttons=fleet.actions.map(action=>({text:names[action],callback_data:`release-${action}:${c.id}`}));
 const heading=fleet.finished ? (fleet.failed+fleet.reverted>0?'Finalizada con incidencias':fleet.pending>0?'Finalizada con pendientes cancelados':'Completada y verificada')
  : fleet.pending===0 && fleet.observing>0 && fleet.applying===0 ? 'Actualización aplicada; verificación en curso'
  : fleet.pending===0 && fleet.applying>0 ? 'Aplicación en curso'
  : fleet.expired && fleet.pending>0 && c.status!=='cancelled' ? 'Autorización vencida para nuevas instalaciones' : releaseLabel(c.status);
 const lines=[c.releaseId,`Campaña: ${heading}`,
  `Marcos: ${c.frames} · pendientes: ${fleet.pending} · aplicando: ${fleet.applying}`,
  `Aplicados en verificación: ${fleet.observing} · verificados: ${fleet.installed} · fallos: ${fleet.failed} · reversiones: ${fleet.reverted}`];
 if(fleet.pending>0 && c.status!=='cancelled') lines.push(`Autorización de nuevas instalaciones hasta: ${releaseTime(c.expiresAt,tz)} (${tz})`);
 if(buttons.length) lines.push(`Acciones sobre ${fleet.pending} pendientes según el último reporte. No detienen operaciones iniciadas ni desinstalan lo aplicado.`);
 if(c.status==='cancelled') lines.push(`Nuevas instalaciones canceladas (${fleet.pending} pendientes según último reporte). No desinstala lo aplicado ni interrumpe una operación ya iniciada.`);
 const assignments=c.assignments ?? [];
 const counts=new Map<string,number>();
 for(const a of assignments) counts.set(a.status,(counts.get(a.status) ?? 0)+1);
 if(assignments.length>5) lines.push([...counts].map(([s,n])=>`${releaseLabel(s)}: ${n}`).join(' · '));
 // Prioritize failures instead of hiding them behind the first alphabetical frames.
 const ordered=[...assignments].sort((a,b)=>Number(['failed','rolled_back'].includes(b.status))-Number(['failed','rolled_back'].includes(a.status)));
 for(const a of ordered.slice(0,5)) {
  const pending=(pendingReleaseStates as readonly string[]).includes(a.status);
  const stages=['pilot','ten-percent','remainder'];
  const waitingForStage=a.stage && c.activeStage && stages.indexOf(a.stage)>stages.indexOf(c.activeStage);
  const state=c.status==='cancelled' && pending ? 'Sin nueva autorización; último reporte: '+releaseLabel(a.status)
   : pending && waitingForStage ? 'Esperando su grupo de despliegue'
   : pending && a.waitingForRelease ? `Esperando actualización anterior: ${a.waitingForRelease}` : releaseLabel(a.status);
  lines.push('',`${a.frameName.slice(0,80)}: ${state}`,
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
 const heading=details.finalSummary ? 'Despliegue finalizado tras cancelar pendientes'
  : status==='completed' ? (Number(details.failed)>0?'Finalizada con incidencias':'Completada y verificada')
  : details.expired ? 'Autorización vencida para nuevas instalaciones'
  : status==='paused' && details.hasFailures ? 'Nuevas instalaciones pausadas por fallos' : releaseLabel(status);
 return [`Naiskos · ${heading}`,String(details.releaseId),
  ...(details.frameName?[`Marco: ${String(details.frameName).slice(0,100)}`]:[]),
  ...(details.error?[`Causa: ${String(details.error).slice(0,1000)}`]:[]),
  ...(details.frames!==undefined?[`Marcos: ${details.frames} · verificados: ${details.installed} · fallos/reversiones: ${details.failed}`]:[]),
  ...(status==='cancelled'?['Cancelar no desinstala lo aplicado ni interrumpe una operación ya iniciada.']:[]),
  `${releaseTime(at)} (America/Lima)`].join('\n');
}
