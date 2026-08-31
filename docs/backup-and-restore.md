# Backup y restauración de Naiskos Server

Este procedimiento protege por separado la base PostgreSQL y los archivos del
dataset de Naiskos. No debe aplicarse al pool raíz ni a bases de otros
servicios.

## Alcance

Cada ejecución correcta contiene:

- un dump PostgreSQL en formato custom, validado con `pg_restore --list`;
- los secretos operativos necesarios para reconstruir los servicios;
- el dataset de objetos desde un snapshot ZFS inmutable;
- el estado persistente del Telegram Bot API desde el mismo snapshot;
- metadatos cifrados y autenticados por Restic.

La contraseña del propio repositorio Restic se excluye deliberadamente. El área
temporal de procesamiento también se excluye. Los archivos nuevos que no
aparezcan todavía en el dump pueden quedar como objetos extra en la copia, pero
el orden dump→snapshot evita que la base restaurada apunte a un objeto posterior
que no esté respaldado.

Los snapshots se montan como sólo lectura dentro del namespace privado del
servicio y en rutas estables bajo `/run`. Así Restic puede reutilizar el árbol
anterior y no releer todos los objetos sin cambios en cada ejecución.

## Política inicial

- Snapshot ZFS recursivo diario: 30 días.
- Restic: 30 copias diarias, 12 semanales y 12 mensuales.
- Horario: 03:30 en `America/Lima`, con demora aleatoria de hasta diez minutos.
- Timer persistente: si el equipo estaba apagado, systemd intenta la ejecución
  pendiente al arrancar.
- Fallos: journal de systemd y mensaje Telegram a los administradores, con tres
  reintentos posteriores al intento inicial.

La ruta de alerta admite `NAISKOS_BACKUP_ALERT_TEST=1` para enviar un mensaje
de prueba inequívoco sin simular un fallo del servicio.

`restic forget` limita su alcance al host y etiqueta `naiskos`, y agrupa por
host+tags para que un cambio interno de rutas no deje una rama sin caducidad.
La limpieza ZFS sólo acepta snapshots del dataset configurado cuyo nombre
comience por `naiskos-auto-`.

## Instalación

Requisitos:

- Restic, ZFS, Docker, `pg_dump`/`pg_restore` y systemd;
- destino externo ya montado;
- UUID conocido del dispositivo de backup;
- espacio para el primer backup y una restauración de prueba;
- entorno del servidor disponible para la alerta Telegram.

El instalador se ejecuta como un usuario administrativo y usa `sudo` sólo para
`/etc`, `/usr/local` y systemd. Las rutas siguientes son ejemplos:

```bash
NAISKOS_DEPLOY_ROOT=/opt/naiskos-server \
NAISKOS_BACKUP_MOUNT=/mnt/backup-naiskos \
NAISKOS_BACKUP_DEVICE_UUID=UUID_ESPERADO \
RESTIC_REPOSITORY=/mnt/backup-naiskos/restic \
NAISKOS_ZFS_DATASET=pool/naiskos \
NAISKOS_STORAGE_ROOT=/var/lib/naiskos-server/storage \
NAISKOS_POSTGRES_CONTAINER=postgres-naiskos \
NAISKOS_SERVER_ENV_SOURCE=/opt/naiskos-server/shared/secrets/server.env \
NAISKOS_SERVICE_USER=naiskos \
NAISKOS_SERVICE_GROUP=naiskos \
./deploy/install-backup
```

El instalador:

1. verifica mount y UUID;
2. genera una contraseña Restic independiente si no existe;
3. inicializa o verifica el repositorio;
4. instala scripts, configuración root-only y unidades;
5. deja el timer deshabilitado hasta superar el primer backup y restore.

La contraseña Restic no se copia al repositorio de backup. Debe guardarse además
en un gestor de secretos u otro medio externo probado: perder simultáneamente
el disco del sistema y esa contraseña vuelve irrecuperable el repositorio.

## Primera validación

```bash
sudo systemctl start naiskos-backup.service
systemctl status naiskos-backup.service
sudo restic snapshots --host NOMBRE_HOST --tag naiskos
```

Sólo después de una restauración correcta:

```bash
sudo systemctl enable --now naiskos-backup.timer
systemctl list-timers naiskos-backup.timer
```

## Restauración de prueba

El helper exige dos nombres explícitamente desechables y se niega a usar la
base `naiskos` o un directorio genérico:

```bash
sudo /usr/local/sbin/naiskos-restore-test \
  /var/tmp/naiskos-restore-ENSAYO \
  naiskos_restore_ensayo
```

La prueba restaura el último snapshot Restic, valida el dump, crea una base
nueva con el rol propietario configurado, ejecuta `pg_restore --no-owner`
asumiendo ese rol, informa conteos y calcula SHA-256 de un objeto recuperado.
No elimina automáticamente la evidencia.

Después de revisarla, el operador debe retirar únicamente los dos destinos
exactos:

```bash
docker exec CONTENEDOR_POSTGRES dropdb -U postgres naiskos_restore_ensayo
sudo rm -rf -- /var/tmp/naiskos-restore-ENSAYO
```

## Restauración ante desastre

1. Instalar una versión compatible de PostgreSQL, ZFS y Restic.
2. Recuperar por un canal separado la contraseña Restic.
3. Restaurar en una ruta y base nuevas; nunca sobre producción directamente.
4. Validar `restic check`, `pg_restore --list`, conteos, hashes y permisos.
5. Detener únicamente API/worker de Naiskos durante el cambio definitivo.
6. Activar la base/dataset restaurados mediante configuración o enlaces
   atómicos y comprobar `/health` antes de reabrir procesamiento.
7. Conservar los destinos anteriores hasta terminar la observación.

Un snapshot ZFS facilita errores locales, pero no sustituye Restic: reside en
el mismo disco que los objetos. Restic tampoco sustituye una copia de su clave
fuera del servidor.
