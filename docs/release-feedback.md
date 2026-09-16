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
