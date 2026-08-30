# Perfil público del bot de Telegram — español

Versión preparada el 28 de agosto de 2026 para `@naiskosbot`.

## Nombre

```text
Naiskos
```

## About

Límite de Telegram: 120 caracteres.

```text
Envía fotos y videos de forma segura a tus marcos digitales Naiskos.
```

## Description

Límite de Telegram: 512 caracteres.

```text
Naiskos conecta Telegram con tus marcos digitales privados. Después de ser autorizado, puedes enviar fotografías y videos a uno o varios marcos. Si tienes acceso a varios, podrás elegir el destino antes de cada envío. Para conservar la mejor calidad, envía el contenido como archivo. Usa /vincular con el código de tu marco y /privacy para consultar cómo se tratan tus datos.
```

## Imágenes

- Botpic: `assets/telegram/botpic-v1.png`.
- Description picture: `assets/telegram/description-picture-640x360-v1.png`.

La imagen de descripción está preparada exactamente a 640 × 360 píxeles y no
incluye texto que pueda competir con la descripción o quedar recortado.

## Commands

Texto para pegar en **Edit Commands** de BotFather:

```text
start - Iniciar o revisar la autorización
vincular - Vincularte a un marco mediante su código
privacy - Consultar la política de privacidad
```

No se añade `/settings`: la configuración de presentación pertenece al marco,
no al perfil del usuario del bot. No se añadirán comandos que sólo dupliquen
botones contextuales.

Los tres comandos se publicaron en el Bot API el 29 de agosto de 2026.
`/start` solicita o revisa la autorización global; `/vincular` acepta el código
visible en **Marco y equipo**; `/privacy` devuelve la política pública. La
selección de destinos usa botones contextuales cuando el usuario posee más de
un marco y no necesita un comando duplicado.

## Privacy Policy

URL pública acordada:

```text
https://naiskos.rji-services.org/privacidad
```

El fuente está en `docs/privacy-policy-es.md`. La URL ya responde mediante
HTTPS con estado 200 y `/privacy` devuelve la misma dirección.

## Opciones que no se habilitan

- Inline mode: no se necesita para recibir medios en conversación privada.
- Groups: no se necesitan en el MVP.
- Mini App: no se necesita en el MVP.
- Channel: no se necesita para autorización ni entrega.
- Group Privacy Mode: se conserva habilitado por defecto; el bot operará en
  chats privados.
