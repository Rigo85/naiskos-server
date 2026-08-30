# Aprovisionamiento de marcos Naiskos

Procedimiento reproducible para crear la identidad lógica de un marco, emitir
o rotar su credencial y generar invitaciones de remitentes. Los comandos de
este documento no registran el dispositivo físico ni despliegan servicios.

## Separación de identidades y QR

- El `frameId` identifica permanentemente al marco lógico.
- El token del agente autentica a la Raspberry. Se entrega una sola vez; en
  PostgreSQL sólo se conserva su SHA-256. No debe aparecer en QR, Git o logs.
- El código de vinculación pertenece a un marco ya registrado. Puede usarse por
  varias personas autorizadas, permanece válido hasta que se cambie desde el
  propio marco y PostgreSQL conserva únicamente su SHA-256.
- El QR abre `https://t.me/naiskosbot?start=frame_<código>`. El mismo valor se
  puede escribir como `/vincular XXXX-XXXX-XXXX`.
- Si la persona escanea antes de recibir aprobación global, la vinculación se
  reserva durante 24 horas. La aprobación completa ambos pasos en una sola
  transacción, sin exigir un segundo escaneo.
- Las invitaciones administrativas de un solo uso se conservan como mecanismo
  auxiliar, pero no son el recorrido normal de un destinatario.

## Registro automático del equipo

La Raspberry Pi 4 real expone un número de serie de 16 caracteres tanto en el
árbol de dispositivos como en `/proc/cpuinfo`; ambas fuentes coincidieron en la
comprobación del 28 de agosto de 2026. El agente aplica esta prioridad:

1. `/proc/device-tree/serial-number`;
2. `Serial` de `/proc/cpuinfo`;
3. `/etc/machine-id`;
4. identificador aleatorio persistente, sólo si no existe otra fuente.

El valor original nunca sale del dispositivo ni se incluye en el QR. Se deriva
una huella SHA-256 con separación de dominio. El número de serie identifica,
pero no autentica: puede copiarse y no se trata como secreto.

En el primer inicio sin credenciales:

1. El agente genera localmente un token aleatorio de 256 bits y un código de
   vinculación de 12 caracteres sin símbolos ambiguos.
2. Persiste el estado local con modo `0600` antes de usar la red.
3. Se autentica con `NAISKOS_DEVICE_BOOTSTRAP_TOKEN`, incluido en la imagen de
   instalación, y envía sólo las huellas SHA-256 del hardware, token del agente
   y código de vinculación, además del modelo, nombre sugerido y resolución.
4. La central crea inmediatamente el marco vacío o recupera el ya asociado a
   esa huella, registra la credencial del agente y devuelve el `frameId`.
5. El agente conserva `device-credentials.json` con modo `0600` y Angular pasa
   al visor. No hay aprobación técnica por Telegram ni intervención por unidad.
6. En **Configuración → Marco y equipo**, Angular muestra el QR y el código que
   vinculan a una persona con ese marco ya existente.

El secreto de bootstrap evita que un cliente arbitrario de Internet cree
marcos. Es una credencial de la imagen de instalación, no una credencial por
Raspberry; se rota al renovar esa imagen. La huella del hardware identifica el
equipo pero no se considera un secreto ni una prueba criptográfica de origen.

## Recorrido del destinatario

1. Enciende el equipo; Naiskos se registra por sí solo si es su primer arranque.
2. Abre `@naiskosbot` y pulsa **Iniciar**.
3. Un administrador aprueba su identidad de Telegram.
4. Abre **Configuración → Marco y equipo** y escanea el QR, o envía al bot el
   código mostrado.
5. El bot crea la membresía usuario–marco. Con un solo marco, los medios se
   destinan directamente a él; con varios, el bot solicita el destino.

## Requisitos

- Node.js 24 y dependencias instaladas.
- Esquema migrado mediante `npm run migrate`.
- `NAISKOS_ADMIN_DATABASE_URL` apuntando a la base Naiskos con el rol de
  aplicación; si falta se usa `DATABASE_URL`.
- `NAISKOS_TELEGRAM_BOT_USERNAME=naiskosbot`.

La URL y las contraseñas se cargan desde el entorno o desde el mecanismo de
secretos del servidor. No se escriben en el repositorio ni se pasan como
argumentos visibles en producción.

## Comandos administrativos

```bash
npm run admin -- frame:create --name "Sala" --width 1280 --height 800
npm run admin -- frame:list
npm run admin -- token:rotate --frame-id <uuid>
npm run admin -- token:revoke --frame-id <uuid> --token-id <uuid>
npm run admin -- invitation:create --frame-id <uuid> --expires-hours 24 --qr-output /ruta/privada/invitacion.png
```

`frame:create` y `token:rotate` muestran el token del agente una sola vez. El
archivo QR se crea con modo `0600` y no sobrescribe un archivo existente.

## Ensayo desechable con PostgreSQL 16

La prueba validada el 28 de agosto de 2026 usa una imagen local
`postgres:16`, el contenedor `naiskos-pg16-integration`, el puerto loopback
`55432` y un `tmpfs`. No se conecta a ninguna infraestructura de producción.

Secuencia:

1. Levantar el contenedor temporal:

   ```bash
   docker run --name naiskos-pg16-integration \
     --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m \
     -e POSTGRES_PASSWORD=<clave-solo-de-prueba> \
     -p 127.0.0.1:55432:5432 \
     -d postgres:16
   ```

2. Esperar a que `pg_isready` confirme que acepta conexiones.
3. Aplicar `database/bootstrap.sql` dentro del contenedor con contraseñas
   exclusivas de prueba.
4. Ejecutar las migraciones con `naiskos_owner`.
5. Ejecutar la integración automatizada con el rol `naiskos_app`:

   ```bash
   TEST_DATABASE_URL=postgresql://naiskos_app:<clave>@127.0.0.1:55432/naiskos \
     npm test -- test/provisioning-postgres.test.ts
   ```

6. Revisar que las pruebas crearon, invitaron, reservaron, aprobaron,
   vincularon, rotaron y revocaron; también verifican hashes, uso único, conteo
   de tokens activos y auditoría. Sus registros de prueba se eliminan al
   terminar.
7. Eliminar el contenedor exacto cuando finalice el ensayo:

   ```bash
   docker rm -f naiskos-pg16-integration
   ```

Al usar `tmpfs`, los datos desaparecen al retirar el contenedor. Antes de
repetir el procedimiento se comprueba siempre el nombre y el puerto para no
afectar otro PostgreSQL local.

## Evidencia obtenida

- Bootstrap y migraciones `001_initial.sql` a
  `004_telegram_user_lifecycle.sql`
  aplicados desde una base vacía.
- Marco de 1280 × 800 creado con UUID.
- Dos credenciales almacenadas únicamente como hashes de 32 bytes.
- Rotación revocó la credencial anterior; revocación dejó cero tokens activos.
- Invitación Telegram almacenada como hash de 32 bytes.
- Reserva de la invitación por un usuario pendiente y consumo atómico durante
  su aprobación global; un segundo consumo fue rechazado.
- QR PNG de 640 × 640, modo `0600`.
- Auditoría: `frame.created`, `frame.invitation.created`,
  `frame.invitation.claimed`, `telegram.user.approved`,
  `frame.invitation.consumed`, `frame.token.rotated` y
  `frame.token.revoked`.
- Alta física con hardware hasheado, token generado localmente, aprobación o
  rechazo Telegram y autenticación posterior del marco.
- Ciclo de usuario: rechazo con nueva solicitud, bloqueo, desbloqueo,
  revocación y reactivación sin restauración implícita de membresías.

## Pendiente para cerrar P1

- Ejecutar el flujo en la Raspberry física cuando exista una central de prueba
  accesible, y revisar visualmente el QR en la pantalla de 1280 × 800.
- Añadir antes de publicar la API límites por IP y un máximo global de
  solicitudes pendientes. Crear una solicitud no concede acceso, pero el
  endpoint inicial necesariamente carece todavía de credencial de marco.
- Probar rotación y recuperación cuando se pierde la credencial local. El
  backend evita duplicar un hardware aprobado, por lo que la recuperación debe
  ser una acción administrativa explícita.
- Mostrar o solicitar desde el marco una nueva invitación cuando se cierre la
  interfaz administrativa correspondiente.
