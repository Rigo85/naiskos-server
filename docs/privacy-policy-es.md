# Política de privacidad de Naiskos

**Vigente desde:** 30 de agosto de 2026

**Servicio:** Naiskos

**Bot:** `@naiskosbot`
**URL prevista:** `https://naiskos.rji-services.org/privacidad`

## 1. Alcance

Esta política explica cómo Naiskos trata los datos recibidos mediante su bot de
Telegram y los datos técnicos estrictamente necesarios para operar marcos
digitales privados, incluyendo sincronización, diagnóstico y clima. Naiskos es
un servicio privado administrado por su propietario y no forma parte de
Telegram ni de Google.

Telegram trata por separado los datos de sus usuarios según su propia
[política de privacidad](https://telegram.org/privacy).

## 2. Datos tratados

Naiskos puede tratar únicamente los datos necesarios para prestar el servicio:

- identificador de usuario y chat de Telegram;
- nombre visible y username, cuando Telegram los proporcione;
- estado de autorización y marcos a los que tiene acceso el usuario;
- fotografías, videos, nombres de archivo y captions enviados al bot;
- marco o marcos elegidos como destino;
- tamaño, tipo, duración, checksum y resultado técnico del procesamiento;
- fechas de recepción, procesamiento, sincronización, eliminación y errores;
- trazas de autorización, entrega, revocación y otras acciones relevantes.
- estado técnico del marco, versión, sincronización y capacidad;
- BSSID de hasta 20 puntos Wi-Fi visibles, tratados transitoriamente para
  calcular la ubicación meteorológica, y coordenadas, precisión y zona horaria
  resultantes.

El bot no solicita contraseña, agenda de contactos, ubicación, información de
pago ni acceso general a la cuenta de Telegram.

Naiskos no recopila SSID, contraseñas Wi-Fi ni perfiles de red. Los BSSID no se
guardan en PostgreSQL, archivos, auditoría ni logs. La IP pública puede ser
observada durante una conexión normal, pero no se conserva como ubicación del
marco.

## 3. Finalidades

Los datos se usan para:

- comprobar que el remitente está autorizado;
- vincularlo con uno o varios marcos;
- recibir, validar, redimensionar o transcodificar sus medios;
- entregar el contenido a los marcos seleccionados;
- informar aceptación, rechazo, errores y falta de capacidad;
- sincronizar, restaurar y proteger el contenido vigente;
- prevenir duplicados, abuso accidental y fallos operativos;
- mantener una auditoría técnica y de seguridad.
- determinar automáticamente las coordenadas necesarias para consultar el
  clima local del marco.

Los datos no se venden, no se usan para publicidad y no se emplean para
entrenar modelos de inteligencia artificial.

## 4. Autorización y control de acceso

Una persona sólo puede enviar contenido después de ser aprobada y obtener
acceso a un marco mediante una invitación válida. Cada marco conserva una
credencial independiente y revocable. Un administrador puede rechazar,
bloquear o revocar usuarios y accesos.

Si una persona tiene acceso a varios marcos, Naiskos le permite escoger el
destino. No se envía silenciosamente a todos sin una selección confirmada o
recordada expresamente.

## 5. Conservación

- Las invitaciones y selecciones pendientes vencen después de 24 horas.
- El original recibido se conserva temporalmente hasta validar el resultado y,
  como máximo ordinario, durante siete días después del procesamiento correcto.
- La versión procesada se conserva mientras esté asignada o sea necesaria para
  recuperar un marco.
- Un contenido eliminado permanece en la papelera central durante 30 días antes
  de su purga definitiva, salvo que otro marco todavía lo utilice.
- Las trazas de auditoría se conservan durante dos años.
- Las coordenadas proporcionadas por Google se renuevan periódicamente y se
  eliminan si no pueden renovarse durante 30 días. El clima válido se conserva
  localmente hasta seis horas para tolerar fallos de red.
- La identidad y las autorizaciones se conservan mientras el acceso esté
  vigente y posteriormente sólo en la medida necesaria para seguridad,
  auditoría o atención de una solicitud.

Las copias eliminadas pueden permanecer temporalmente en backups rotativos
hasta su vencimiento. Esos backups sólo se usan para recuperación ante fallos.

## 6. Almacenamiento y terceros

Los metadatos y medios de Naiskos se almacenan en infraestructura administrada
por el propietario. Telegram interviene como canal de recepción y mensajería.
Google Geolocation recibe BSSID visibles para producir coordenadas con
`considerIp: false`; Open-Meteo recibe esas coordenadas para producir el clima.
Se aplican además las políticas de [Google](https://policies.google.com/privacy)
y [Google Maps Platform](https://cloud.google.com/maps-platform/terms), y la
[política de Open-Meteo](https://open-meteo.com/en/terms). Naiskos no entrega
estos datos a anunciantes ni comercializa información de sus usuarios.

## 7. Seguridad

Naiskos aplica credenciales revocables por marco, conexiones cifradas para los
dispositivos, verificación de integridad, cambios atómicos de manifiesto,
permisos restringidos, backups, auditoría y secretos fuera del código fuente.
Ningún sistema puede garantizar riesgo cero, pero los accesos y errores se
revisan y pueden ser revocados.

## 8. Solicitudes del usuario

El usuario puede solicitar:

- conocer los datos y accesos asociados a su identidad de Telegram;
- corregir su nombre informativo;
- conocer o eliminar la ubicación meteorológica asociada a su marco;
- revocar el acceso a uno o varios marcos;
- eliminar contenido de un marco;
- eliminar su relación activa con Naiskos, sujeto a las retenciones de
  seguridad y backups indicadas.

Para iniciar una solicitud se usa el comando `/privacy` en `@naiskosbot` y la
opción **Contactar al administrador**. El bot debe confirmar la recepción y
dejar una traza de la resolución.

## 9. Cambios

Si esta política cambia de manera relevante, Naiskos actualizará la fecha de
vigencia y notificará a los usuarios autorizados mediante el bot antes de que
el cambio produzca efectos cuando sea razonablemente posible.
