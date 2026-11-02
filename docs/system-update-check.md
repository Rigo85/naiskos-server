# Reportes de consulta del SO

Compatibilidad: se reciben los reportes anteriores (`count`, `error` opcional)
y baseline 19 (`status`, `checkSequence`, ID/fecha persistidos). Los fallos nuevos
no llevan conteo. `deferred` se audita como evento pero no abre ni resuelve una
alarma; estar ocupado no equivale a una consulta correcta.

El mismo ID no vuelve a producir transiciones ni avisos. Un advisory lock por
marco serializa consultas/mantenimiento concurrentes. La secuencia de consultas
evita que una corrección de reloj o entrega tardía reabra un fallo ya superado.
Los clientes anteriores se ordenan por fecha de ocurrencia. Entre consulta y
mantenimiento se utiliza esa fecha, porque son flujos distintos: no se inventa
una secuencia compartida que los clientes anteriores no tienen.

Se conserva el conteo anterior cuando falla una consulta. Sólo un éxito resuelve
su aviso de fallo. Los conteos tardíos no sustituyen observaciones posteriores
de mantenimiento, ni viceversa. Esto no modifica las campañas mensuales ni su
criterio de salud/observación. No certifica que los índices locales sean frescos.

La migración 020 añade un índice parcial de `device_events` para estos dos tipos
de evento; no cambia datos, tablas de otros servicios ni permisos. Aplicarla con
timeout de locks antes de arrancar la nueva central. El índice es compatible con
el servidor anterior si se revierte el despliegue.

Prueba con PostgreSQL aislado: `test/system-update-check-postgres.test.ts`.
Desplegar la central primero y luego el paquete firmado con baseline 19.
