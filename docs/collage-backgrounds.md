# Fondos de bandas para collage

La migración `019_media_band_colors.sql` añade `band_colors` opcional a las
variantes. El worker extrae dos tonos suaves de la **foto normalizada completa**
o del **póster de video**; no usa miniaturas recortadas. También se calcula al
generar variantes rotadas. Se reduce a una muestra RGB 32×32 con timeout; no se
analizan videos completos ni se añade trabajo en el marco.

Una extracción fallida registra `media.band-colors.unavailable` y devuelve null.
No debe convertir una ingestión correcta en un fallo. El manifiesto expone
`media[].bandColors`; ausencia o valor no válido implica fondo negro en el visor.
Los archivos y sus hashes no cambian. No se requiere recompresión de la biblioteca.

## Biblioteca existente

Primero instalar agente/visor compatibles. Ejecutar con el entorno del servidor:

```bash
node dist/band-colors-backfill-main.js --frame-id <uuid>
node dist/band-colors-backfill-main.js --frame-id <uuid> --apply --all
```

Sin `--apply` sólo mide. Cada lote incluye hasta 200 variantes, se procesa
secuencialmente y publica una vez por marco afectado, dentro de la misma
transacción que guarda colores. `--all` recorre lotes por UUID; `--after-id`
permite continuar desde el `nextCursor` registrado. Un fallo de lectura no
bloquea otros materiales ni produce un bucle infinito. Una ejecución posterior
puede reintentar los fallidos; las variantes completas se omiten.

La ruta real debe permanecer dentro del almacenamiento. Cada UPDATE vuelve a
comprobar ID/hash y ausencia de color; no modifica preferencias ni resucita medios
eliminados. Las referencias compartidas notifican todos los marcos afectados.

El orden aleatorio deja de depender de manifest_version (servidor y visor usan
la misma función). Puede variar una vez al actualizar desde la versión antigua;
los metadatos decorativos no lo alteran después. En flotas mixtas, completar
primero la actualización del visor antes de publicar el relleno histórico.

Rollback: volver al servidor anterior es compatible con la columna nullable;
no es necesario eliminarla ni borrar los colores. Volver al agente/visor anterior
simplemente deja de utilizar la nueva decoración.
