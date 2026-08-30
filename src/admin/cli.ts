import { parseArgs } from "node:util";

import { Pool } from "pg";

import {
  PostgresProvisioningStore,
  ProvisioningService,
  writeInvitationQr,
} from "./provisioning.js";

export type AdminCommand =
  | { kind: "help" }
  | {
      kind: "frame:create";
      name: string;
      width: number;
      height: number;
      tokenLabel: string;
      json: boolean;
    }
  | { kind: "frame:list"; json: boolean }
  | {
      kind: "token:rotate";
      frameId: string;
      tokenLabel: string;
      json: boolean;
    }
  | {
      kind: "token:revoke";
      frameId: string;
      tokenId: string;
      json: boolean;
    }
  | {
      kind: "invitation:create";
      frameId: string;
      expiresInHours: number;
      qrOutput?: string;
      json: boolean;
    };

const HELP = `Naiskos Admin

Uso:
  npm run admin -- frame:create --name <nombre> [--width 1280] [--height 800]
  npm run admin -- frame:list [--json]
  npm run admin -- token:rotate --frame-id <uuid> [--token-label primary]
  npm run admin -- token:revoke --frame-id <uuid> --token-id <uuid>
  npm run admin -- invitation:create --frame-id <uuid> [--expires-hours 24] [--qr-output archivo.png]

Opciones comunes:
  --json       salida estructurada; puede contener secretos de una sola lectura
  -h, --help   mostrar esta ayuda

Variables:
  NAISKOS_ADMIN_DATABASE_URL     conexión administrativa; fallback: DATABASE_URL
  NAISKOS_TELEGRAM_BOT_USERNAME fallback: naiskosbot
`;

export function adminHelp(): string {
  return HELP;
}

export function parseAdminCommand(args: string[]): AdminCommand {
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help" };
  }
  const rest = args.slice(1);
  if (command === "frame:create") {
    const values = parse(rest, {
      name: { type: "string" },
      width: { type: "string", default: "1280" },
      height: { type: "string", default: "800" },
      "token-label": { type: "string", default: "primary" },
      json: { type: "boolean", default: false },
    });
    return {
      kind: command,
      name: required(values.name, "--name"),
      width: integer(values.width, "--width"),
      height: integer(values.height, "--height"),
      tokenLabel: required(values["token-label"], "--token-label"),
      json: Boolean(values.json),
    };
  }
  if (command === "frame:list") {
    const values = parse(rest, {
      json: { type: "boolean", default: false },
    });
    return { kind: command, json: Boolean(values.json) };
  }
  if (command === "token:rotate") {
    const values = parse(rest, {
      "frame-id": { type: "string" },
      "token-label": { type: "string", default: "primary" },
      json: { type: "boolean", default: false },
    });
    return {
      kind: command,
      frameId: required(values["frame-id"], "--frame-id"),
      tokenLabel: required(values["token-label"], "--token-label"),
      json: Boolean(values.json),
    };
  }
  if (command === "token:revoke") {
    const values = parse(rest, {
      "frame-id": { type: "string" },
      "token-id": { type: "string" },
      json: { type: "boolean", default: false },
    });
    return {
      kind: command,
      frameId: required(values["frame-id"], "--frame-id"),
      tokenId: required(values["token-id"], "--token-id"),
      json: Boolean(values.json),
    };
  }
  if (command === "invitation:create") {
    const values = parse(rest, {
      "frame-id": { type: "string" },
      "expires-hours": { type: "string", default: "24" },
      "qr-output": { type: "string" },
      json: { type: "boolean", default: false },
    });
    const qrOutput = values["qr-output"];
    return {
      kind: command,
      frameId: required(values["frame-id"], "--frame-id"),
      expiresInHours: integer(values["expires-hours"], "--expires-hours"),
      ...(typeof qrOutput === "string" ? { qrOutput } : {}),
      json: Boolean(values.json),
    };
  }
  throw new Error(`Comando desconocido: ${command}. Usa --help.`);
}

export async function runAdminCommand(
  command: AdminCommand,
  environment: NodeJS.ProcessEnv = process.env,
  write: (text: string) => void = (text) => console.log(text),
): Promise<void> {
  if (command.kind === "help") {
    write(HELP.trimEnd());
    return;
  }
  const databaseUrl =
    environment.NAISKOS_ADMIN_DATABASE_URL ?? environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("NAISKOS_ADMIN_DATABASE_URL o DATABASE_URL es obligatorio.");
  }
  const database = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: "naiskos-admin",
  });
  const service = new ProvisioningService(
    new PostgresProvisioningStore(database),
    environment.NAISKOS_TELEGRAM_BOT_USERNAME ?? "naiskosbot",
  );
  try {
    if (command.kind === "frame:create") {
      const result = await service.createFrame(command);
      output(command.json, result, write, [
        `Marco creado: ${result.name}`,
        `Frame ID: ${result.frameId}`,
        `Token ID: ${result.tokenId}`,
        "Token del agente —se muestra una sola vez—:",
        result.agentToken,
        "",
        "Variables para /etc/naiskos/agent.env:",
        `NAISKOS_FRAME_ID=${result.frameId}`,
        `NAISKOS_AGENT_TOKEN=${result.agentToken}`,
      ]);
      return;
    }
    if (command.kind === "frame:list") {
      const result = await service.listFrames();
      output(
        command.json,
        result,
        write,
        result.length
          ? result.map(
              (frame) =>
                `${frame.id}  ${frame.status.padEnd(12)}  v${frame.manifestVersion}  tokens=${frame.activeTokenCount}  ${frame.name}`,
            )
          : ["No hay marcos."],
      );
      return;
    }
    if (command.kind === "token:rotate") {
      const result = await service.rotateToken(command);
      output(command.json, result, write, [
        `Token rotado para: ${result.frameName}`,
        `Tokens anteriores revocados: ${result.revokedCount}`,
        `Token ID: ${result.tokenId}`,
        "Token del agente —se muestra una sola vez—:",
        result.agentToken,
      ]);
      return;
    }
    if (command.kind === "token:revoke") {
      await service.revokeToken(command);
      output(command.json, { revoked: true, ...command }, write, [
        `Token revocado: ${command.tokenId}`,
      ]);
      return;
    }
    const invitation = await service.createInvitation(command);
    const qrPath = command.qrOutput
      ? await writeInvitationQr(invitation.deepLink, command.qrOutput)
      : null;
    const result = { ...invitation, qrPath };
    output(command.json, result, write, [
      `Invitación creada para: ${invitation.frameName}`,
      `Vence: ${invitation.expiresAt}`,
      `Enlace —se muestra una sola vez—: ${invitation.deepLink}`,
      ...(qrPath ? [`QR: ${qrPath}`] : []),
    ]);
  } finally {
    await database.end();
  }
}

function parse(
  args: string[],
  options: Record<
    string,
    {
      type: "string" | "boolean";
      default?: string | boolean;
    }
  >,
): Record<string, string | boolean | undefined> {
  const result = parseArgs({ args, options, strict: true, allowPositionals: false });
  return result.values as Record<string, string | boolean | undefined>;
}

function required(value: string | boolean | undefined, option: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${option} es obligatorio.`);
  }
  return value;
}

function integer(value: string | boolean | undefined, option: string): number {
  const parsed = Number(required(value, option));
  if (!Number.isInteger(parsed)) throw new Error(`${option} debe ser un entero.`);
  return parsed;
}

function output(
  json: boolean,
  value: unknown,
  write: (text: string) => void,
  lines: string[],
): void {
  write(json ? JSON.stringify(value, null, 2) : lines.join("\n"));
}
