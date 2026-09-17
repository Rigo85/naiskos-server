# Seguimiento de releases en Telegram

`/versiones` mantiene un mensaje canónico por campaña y chat administrativo.
Muestra autorización separada de ejecución, fases por marco, último reporte en
hora local, causas y observación requerida. Para flotas grandes resume fases y
prioriza los fallos en el detalle; no inventa porcentajes ni tiempo restante.
Cancelar no desinstala paquetes ni interrumpe una activación ya iniciada.

La migración SQL 018 captura resultados y cambios de campaña en la misma
transacción mediante triggers. No genera eventos retrospectivos para campañas
históricas. Los resultados exitosos individuales se muestran en el mensaje de
estado; sólo el cierre de campaña produce el aviso de éxito, evitando dos
avisos para un piloto de un marco. Fallo, reversión, pausa y cancelación/vencimiento
producen avisos independientes, persistentes y deduplicados por evento/chat.

La API vacía esta cola cada 30 segundos, separada del monitor de salud. Un lock
de transacción por campaña/chat serializa consultas, callbacks y refrescos.
Los fallos de transporte conservan su intento y causa, con backoff hasta una
hora y respeto a `retry_after`. Un reinicio no borra pendientes. Si se borró
el mensaje canónico se reemplaza al siguiente cambio/refresco necesario.
`message is not modified` se considera confirmación de una edición ya aplicada.
No se envían pendientes a administradores retirados de la configuración.

Telegram no ofrece clave de idempotencia para `sendMessage`: si acepta el
mensaje y se pierde la respuesta, un reintento puede duplicarlo. Las ediciones
con ID conocido sí son repetibles; no se promete entrega exactamente una vez.
Las tablas `release_feedback_events` y `release_feedback_deliveries` conservan
evidencia de entrega, errores y reintentos. Los reintentos no reejecutan releases.

El baseline 15 y el agente reportan `healthConfirmed:true` una vez que una
muestra local pasa la verificación funcional durante observación. Se usa un ID
durable distinto del reporte inicial. La central limpia la nota transitoria y
no permite que un reporte anterior la reinstale. No se convierte ese reporte
en instalación completada y no se modifican criterios ni duración de observación.

Despliegue: migración SQL aditiva primero, central después y paquete firmado
del marco finalmente. Compatible con marcos anteriores, que no confirman salud
durante observación. No borrar notas antiguas por inferencia. Rollback central
no exige deshacer las tablas aditivas; conservarlas para mantener pendientes.
## Coordinación por flota

El estado administrativo de la campaña no determina por sí solo los botones.
`release-campaign-policy.ts` calcula pendientes, aplicando, aplicados en
verificación, verificados, fallidos y revertidos a partir de todas las
asignaciones, incluidas cohortes posteriores. La misma política valida los
callbacks en el servidor. No existe una excepción para campañas de un marco.

- Pausar/cancelar/reanudar se ofrece sólo si quedan instalaciones pendientes.
  No detiene operaciones ya iniciadas ni desinstala versiones aplicadas.
  Los conteos son según el último reporte recibido, no una garantía de corte
  instantáneo sobre equipos desconectados o autorizaciones ya entregadas.
- Si todos están aplicando o verificándose, desaparecen esos botones. El texto
  distingue aplicación de verificación; no interpreta cero verificaciones como
  cero instalaciones.
- El servidor bloquea las filas de campaña en orden estable al procesar lotes
  de reportes y usa el mismo bloqueo para comandos y reconciliación. Un botón
  obsoleto es rechazado y refresca el mensaje existente.
- El cierre/avance se reevalúa tras reportes y acciones y cada minuto. Una
  campaña pausada cuyos marcos terminan no necesita otro reporte para cerrar.
  Finalizada con incidencias nunca se presenta como éxito total.
- Los fallos que alcanzan el umbral pausan nuevas instalaciones. Reanudar
  explícitamente permite seguir con las cohortes pendientes; no reintenta
  asignaciones fallidas ni borra sus resultados. Si los fallos no alcanzan el
  umbral, una cohorte terminal puede avanzar según la política existente.
- Vencer la autorización bloquea sólo nuevas instalaciones: no cancela una
  observación iniciada. Los resultados tardíos se conservan; no se reinician
  los marcos ya verificados. Un equipo que llega un día después puede instalar
  si sigue autorizado, dentro del plazo y en una cohorte habilitada.
- Una segunda release descargada identifica en el mensaje la release anterior
  que aún se aplica/verifica; no la llama simplemente «esperando ventana».

Los mensajes de seguimiento conservan su identificador y se editan con texto
y teclado juntos. La actualización periódica es cada 30 segundos en condiciones
normales; fallos de Telegram usan la cola durable y respetan `retry_after`.
No se promete entrega exactamente una vez de un mensaje nuevo si Telegram lo
acepta pero se pierde su respuesta. Las ediciones sí reutilizan el mismo ID.

Pruebas: `release-campaign-policy.test.ts`, `release-fleet-postgres.test.ts`,
`release-feedback-postgres.test.ts` y `release-status-order-postgres.test.ts`.
La coordinación central no necesita cambiar el esquema ni los paquetes del
marco; conserva la verificación y el rollback locales existentes.
