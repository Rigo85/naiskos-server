# Naiskos Server

Servicio central de Naiskos. Reúne la API HTTP, el webhook y los flujos del bot
de Telegram, el aprovisionamiento de marcos y el worker que normaliza
fotografías y videos antes de publicarlos mediante manifiestos versionados.

## Arquitectura

El proyecto genera dos procesos independientes:

- `naiskos-api`: autenticación de marcos, manifiestos, archivos, clima,
  aprovisionamiento y webhook de Telegram.
- `naiskos-worker`: descarga el contenido aceptado, lo valida, crea variantes y
  pósteres y publica los cambios al finalizar.

PostgreSQL conserva estado, auditoría, usuarios, relaciones con marcos,
versiones y cola de trabajo. El almacenamiento de objetos permanece fuera de
las releases. El Telegram Bot API local es opcional: también puede utilizarse
la API HTTPS oficial configurando `TELEGRAM_API_BASE`.

La telemetría de cada marco conserva capacidad, espacio realmente usado,
disponible y reservado del filesystem, además del peso total de la data local
y de sus medios. El porcentaje usa la misma fórmula que `df`; las columnas son
opcionales para mantener compatibilidad durante la actualización gradual de
agentes anteriores.

Las notificaciones operativas se persisten por marco. El servicio deduplica
incidentes, conserva lectura/ocultación y entrega al agente los últimos 100
avisos visibles. Cuando el disco reportado llega al 90 %, el contenido nuevo se
procesa pero queda `pending_capacity`, fuera del manifiesto, hasta que la
telemetría confirme la recuperación.

## Requisitos

- Node.js 24 y npm 11.
- PostgreSQL 16.
- FFmpeg y FFprobe para videos.
- Dependencias nativas requeridas por `sharp` para la plataforma utilizada.
- Opcionalmente `geoipupdate` y una base GeoLite2 City.

Los servicios externos utilizados son Telegram, Google Geolocation —sólo si se
configura una clave—, MaxMind GeoLite2 y Open-Meteo. Las peticiones externas
tienen timeout y al menos tres reintentos posteriores al intento inicial.

## Desarrollo local

1. Crea una base PostgreSQL exclusiva y desechable.
2. Copia `.env.example` a `.env` y reemplaza todos los valores de ejemplo.
3. Instala, compila y migra:

```bash
npm ci
npm run build
node --env-file=.env dist/migrate.js
npm test
```

Inicia la API:

```bash
node --env-file=.env dist/api-main.js
```

En otra terminal inicia el worker:

```bash
node --env-file=.env dist/worker-main.js
```

Comprueba la API con `GET http://127.0.0.1:8090/health`. No apuntes pruebas,
migraciones exploratorias ni el ensayo completo a una base compartida o de
producción.

Comandos:

| Comando | Función |
| --- | --- |
| `npm run build` | Compilar TypeScript en `dist/` |
| `npm run typecheck` | Validar tipos sin emitir archivos |
| `npm test` | Pruebas unitarias y de integración aislada |
| `npm run migrate` | Aplicar migraciones con el entorno ya cargado |
| `npm run admin -- --help` | CLI de administración y aprovisionamiento |
| `npm run prepare:test-photos` | Normalizar un lote fotográfico de prueba |
| `npm run prepare:test-videos` | Normalizar un lote de videos de prueba |
| `npm run test:full-pipeline` | Ensayo API–worker–agente con PostgreSQL temporal |

## Configuración

La aplicación no carga `.env` implícitamente. Usa `node --env-file`, PM2,
systemd o un gestor de secretos. Consulta `.env.example`; las variables se
agrupan así:

| Grupo | Variables principales |
| --- | --- |
| HTTP | `NAISKOS_HOST`, `NAISKOS_PORT`, `NAISKOS_PUBLIC_URL`, `NAISKOS_TRUSTED_PROXIES` |
| PostgreSQL | `DATABASE_URL`, `NAISKOS_ADMIN_DATABASE_URL`, `NAISKOS_DB_POOL_MAX` |
| Archivos | `NAISKOS_STORAGE_ROOT`, retención de originales y papelera |
| Telegram | token del bot, secreto del webhook, API base, administradores y nombre público |
| Dispositivos | `NAISKOS_DEVICE_BOOTSTRAP_TOKEN` |
| Ubicación | ruta GeoLite2, clave de Google y límites de precisión/caché |
| Clima | URL de Open-Meteo, refresco, caducidad y cooldown |
| Red externa | timeout y cantidad de reintentos |
| Worker | timeout para recuperar locks abandonados |

Los valores `CHANGE_ME`, `example.com` y las credenciales vacías del ejemplo
no son válidos para producción. El token de bootstrap, el token del bot, el
secreto del webhook y las claves de terceros deben generarse por separado y
guardarse fuera del repositorio.

## Base de datos

`database/bootstrap.sql` crea una base y roles dedicados cuando se ejecuta con
un administrador PostgreSQL. Es una operación de una sola vez y aborta si el
estado esperado ya existe. Después deben usarse:

- un rol propietario para migraciones;
- un rol de aplicación con privilegios mínimos para API y worker;
- opcionalmente un rol de sólo lectura para diagnóstico.

Las migraciones numeradas en `database/migrations/` son acumulativas. Realiza
un respaldo comprobable antes de aplicarlas en producción y no mezcles tablas
de Naiskos con esquemas pertenecientes a otros servicios.

## Flujo de dispositivos y Telegram

1. El agente obtiene una identidad estable del hardware, genera su token y
   registra el marco vacío mediante el secreto de bootstrap.
2. Un usuario inicia el bot y un administrador aprueba o rechaza su acceso
   desde Telegram.
3. El usuario envía al bot el QR/código de vinculación mostrado por el marco.
4. Con un marco vinculado, las fotos y videos enviados se agregan a su cola; si
   tiene varios, el bot solicita el destino.
5. El worker procesa el contenido y sólo entonces incrementa el manifiesto.
6. Cada agente descarga y activa su nueva versión sin interrumpir el medio que
   está mostrando.

Los duplicados no publican otra versión. Los fallos definitivos y el bloqueo de
capacidad notifican al marco y por Telegram; los trabajos abandonados vuelven a
estar disponibles después del timeout configurado.

El contrato y las pruebas manuales están en
[`docs/aprovisionamiento-marcos.md`](docs/aprovisionamiento-marcos.md).

## Procesamiento multimedia

Fotografías:

- orientación incorporada;
- maestro WebP de calidad 88;
- resolución suficiente para alternar `contain` y `cover` en el marco;
- nombre direccionado por SHA-256.

Videos:

- validación con FFprobe y límite predeterminado de 120 segundos;
- MP4/H.264, `yuv420p`, dimensiones pares y `faststart`;
- AAC estéreo a 48 kHz;
- póster JPEG coherente;
- reinspección de la salida antes de publicarla.

Rotar crea una variante absoluta desde el maestro normalizado. Eliminar afecta
sólo la relación con el marco solicitante y conserva la retención configurada.
Las operaciones son idempotentes y se auditan con actor opcional.

## Ensayo completo aislado

Compila este proyecto y el agente, prepara una base PostgreSQL temporal ya
migrada y usa medios no sensibles:

```bash
npm run build
npm --prefix ../naiskos-agent run build
TEST_DATABASE_URL=postgresql://usuario:clave@127.0.0.1:55432/naiskos_test \
TEST_PHOTO_PATH=/ruta/foto.jpg \
TEST_VIDEO_PATH=/ruta/video.mp4 \
npm run test:full-pipeline
```

El ensayo crea identidades y almacenamiento temporales, procesa ambos medios,
verifica hashes y sincronización y limpia sus datos al finalizar.

## Despliegue

`deploy/ecosystem.config.cjs` define API, worker y Bot API local para PM2. Sus
rutas públicas usan `/opt/naiskos-server` y `/var/lib/naiskos-server` como
ejemplos neutrales; pueden sustituirse mediante variables. Los archivos Nginx
usan `naiskos.example.com` y `127.0.0.1:8090`: reemplázalos y valida con
`nginx -t` antes de instalarlos.

Flujo recomendado:

1. Crear usuario/grupo dedicados y directorios de releases, secretos,
   almacenamiento y respaldos.
2. Publicar un artefacto compilado e inmutable y actualizar el enlace
   `current` sólo después de verificarlo.
3. Instalar secretos con modo `0600` y cargar migraciones con el rol
   propietario.
4. Arrancar API y worker con límites de memoria independientes.
5. Configurar TLS y proxy inverso; el webhook no debe exponerse como una ruta
   pública ordinaria cuando se usa Bot API local.
6. Verificar salud, webhook, cola, procesamiento, descarga autenticada y
   rollback.

`deploy/create-zfs-storage` exige indicar explícitamente el dataset padre y no
modifica sus propiedades. Los scripts abortan ante recursos ya existentes;
revísalos para la plataforma concreta antes de ejecutarlos.

## Seguridad y publicación

- `.env`, `storage/`, `dist/`, logs, bases GeoLite y respaldos están fuera de
  Git.
- No se registran tokens, contraseñas, BSSID completos ni contenido multimedia.
- Los manifiestos y archivos requieren autenticación del marco.
- El webhook valida `X-Telegram-Bot-Api-Secret-Token` y deduplica `update_id`.
- Las plantillas no contienen nombres de hosts, usuarios, IP internas,
  datasets ni rutas de la infraestructura real.
- Los informes históricos de producción se guardan fuera de este repositorio.

La política de privacidad publicable está en
[`docs/privacy-policy-es.md`](docs/privacy-policy-es.md) y el texto del perfil
del bot en [`docs/telegram-bot-profile-es.md`](docs/telegram-bot-profile-es.md).
