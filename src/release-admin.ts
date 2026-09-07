#!/usr/bin/env node

import { createHash, randomUUID, verify } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.js";
import { createDatabase, transaction } from "./db.js";

const HELP = `Naiskos software releases

  npm run release-admin -- publish --manifest release.json --signature release.json.sig --archive release.tar.gz
  npm run release-admin -- campaign:create --release-id <id> --frames <uuid,uuid> [--from 00:00] [--until 06:00] [--expires-hours 72]
  npm run release-admin -- campaign:approve --campaign-id <uuid>
  npm run release-admin -- list

Publicar exige NAISKOS_RELEASE_PUBLIC_KEY y verifica firma, SHA-256 y tamaño antes de copiar.`;

const config = loadConfig();
const database = createDatabase(config);

try {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
  } else if (command === "publish") {
    const args = parseArgs({
      args: rest,
      strict: true,
      options: {
        manifest: { type: "string" },
        signature: { type: "string" },
        archive: { type: "string" },
      },
    }).values;
    const manifestSource = required(args.manifest, "--manifest");
    const signatureSource = required(args.signature, "--signature");
    const archiveSource = required(args.archive, "--archive");
    const publicKeyPath = required(process.env.NAISKOS_RELEASE_PUBLIC_KEY, "NAISKOS_RELEASE_PUBLIC_KEY");
    const [manifestBytes, signature, publicKey, archiveDetails] = await Promise.all([
      readFile(manifestSource),
      readFile(signatureSource),
      readFile(publicKeyPath),
      stat(archiveSource),
    ]);
    if (!verify(null, manifestBytes, publicKey, signature)) {
      throw new Error("La firma Ed25519 del manifiesto no es válida.");
    }
    const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
    if (path.basename(archiveSource) !== manifest.archive.filename) {
      throw new Error("El nombre del archivo no coincide con el manifiesto.");
    }
    if (archiveDetails.size !== manifest.archive.sizeBytes) {
      throw new Error("El tamaño del archivo no coincide con el manifiesto.");
    }
    const hash = createHash("sha256").update(await readFile(archiveSource)).digest("hex");
    if (hash !== manifest.archive.sha256) {
      throw new Error("El SHA-256 del archivo no coincide con el manifiesto.");
    }
    const relativeRoot = path.join("software-releases", manifest.releaseId);
    const destinationRoot = path.join(config.storageRoot, relativeRoot);
    await mkdir(path.dirname(destinationRoot), { recursive: true, mode: 0o750 });
    await mkdir(destinationRoot, { recursive: false, mode: 0o750 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`La versión ${manifest.releaseId} ya tiene archivos publicados.`);
      }
      throw error;
    });
    const destinations = {
      manifest: path.join(destinationRoot, "release.json"),
      signature: path.join(destinationRoot, "release.json.sig"),
      archive: path.join(destinationRoot, manifest.archive.filename),
    };
    try {
      await copyAtomic(manifestSource, destinations.manifest);
      await copyAtomic(signatureSource, destinations.signature);
      await copyAtomic(archiveSource, destinations.archive);
      await database.query(
        `INSERT INTO naiskos.software_releases
           (release_id,manifest,manifest_path,signature_path,archive_path,
            archive_size_bytes,archive_sha256,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'published')`,
        [
          manifest.releaseId,
          JSON.stringify(manifest),
          path.relative(config.storageRoot, destinations.manifest),
          path.relative(config.storageRoot, destinations.signature),
          path.relative(config.storageRoot, destinations.archive),
          manifest.archive.sizeBytes,
          manifest.archive.sha256,
        ],
      );
    } catch (error) {
      await rm(destinationRoot, { recursive: true, force: true });
      throw error;
    }
    console.log(`Publicada ${manifest.releaseId}`);
  } else if (command === "campaign:create") {
    const args = parseArgs({
      args: rest,
      strict: true,
      options: {
        "release-id": { type: "string" },
        frames: { type: "string" },
        from: { type: "string", default: "00:00" },
        until: { type: "string", default: "06:00" },
        "observe-minutes": { type: "string", default: "60" },
        "expires-hours": { type: "string", default: "72" },
      },
    }).values;
    const releaseId = required(args["release-id"], "--release-id");
    const requestedFrames = required(args.frames, "--frames");
    const frameIds = requestedFrames === "all"
      ? (await database.query<{ id: string }>(
          `SELECT id FROM naiskos.frames WHERE status='active' ORDER BY id`,
        )).rows.map((row) => row.id)
      : requestedFrames.split(",").map((value) => value.trim());
    if (!frameIds.length || frameIds.some((id) => !isUuid(id))) throw new Error("--frames no resolvió marcos válidos.");
    const from = validTime(required(args.from, "--from"));
    const until = validTime(required(args.until, "--until"));
    const observeMinutes = Number(args["observe-minutes"]);
    if (!Number.isInteger(observeMinutes) || observeMinutes < 1 || observeMinutes > 10080)
      throw new Error("--observe-minutes debe estar entre 1 y 10080.");
    const expiresHours = Number(args["expires-hours"]);
    if (!Number.isInteger(expiresHours) || expiresHours < 1 || expiresHours > 720)
      throw new Error("--expires-hours debe estar entre 1 y 720.");
    const expiresAt = new Date(Date.now() + expiresHours * 60 * 60_000);
    const campaignId = randomUUID();
    await transaction(database, async (client) => {
      await client.query(
        `INSERT INTO naiskos.release_campaigns
           (id,release_id,status,maintenance_from,maintenance_until,observe_minutes,
            expires_at,created_by)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,'admin-cli')`,
        [campaignId, releaseId, from, until, observeMinutes, expiresAt],
      );
      const uniqueFrames = [...new Set(frameIds)].sort();
      const pilotLimit = Math.max(1, Math.ceil(uniqueFrames.length * 0.01));
      const tenPercentLimit = Math.max(pilotLimit, Math.ceil(uniqueFrames.length * 0.1));
      for (const [index, frameId] of uniqueFrames.entries()) {
        const stage = index < pilotLimit
          ? "pilot"
          : index < tenPercentLimit
            ? "ten-percent"
            : "remainder";
        await client.query(
          `INSERT INTO naiskos.release_assignments (campaign_id,frame_id,stage)
           VALUES ($1,$2,$3)`,
          [campaignId, frameId, stage],
        );
      }
      await client.query(
        `INSERT INTO naiskos.audit_log (action,details) VALUES ('release.campaign.created',$1)`,
        [JSON.stringify({
          campaignId,
          releaseId,
          frameIds,
          expiresAt: expiresAt.toISOString(),
        })],
      );
    });
    console.log(`Campaña borrador: ${campaignId} (vence ${expiresAt.toISOString()})`);
  } else if (command === "campaign:approve") {
    const args = parseArgs({
      args: rest,
      strict: true,
      options: { "campaign-id": { type: "string" } },
    }).values;
    const campaignId = required(args["campaign-id"], "--campaign-id");
    if (!isUuid(campaignId)) throw new Error("--campaign-id no es un UUID.");
    const result = await database.query(
      `UPDATE naiskos.release_campaigns
          SET status='approved', approved_at=now(), approved_by='admin-cli'
        WHERE id=$1 AND status='draft' AND expires_at > now()`,
      [campaignId],
    );
    if (!result.rowCount) {
      throw new Error("La campaña no existe, no está en borrador o ya venció.");
    }
    await database.query(
      `INSERT INTO naiskos.audit_log (action,details) VALUES ('release.campaign.approved',$1)`,
      [JSON.stringify({ campaignId })],
    );
    console.log(`Campaña aprobada: ${campaignId}`);
  } else if (command === "list") {
    const result = await database.query(
      `SELECT c.id,c.release_id,c.status,c.created_at,c.expires_at,
              count(a.frame_id)::integer AS frames,
              count(*) FILTER (WHERE a.status='installed')::integer AS installed,
              count(*) FILTER (WHERE a.status IN ('failed','rolled_back'))::integer AS failed
         FROM naiskos.release_campaigns c
         LEFT JOIN naiskos.release_assignments a ON a.campaign_id=c.id
        GROUP BY c.id ORDER BY c.created_at DESC LIMIT 50`,
    );
    console.log(JSON.stringify(result.rows, null, 2));
  } else {
    throw new Error(`Comando desconocido: ${command}`);
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await database.end();
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} es obligatorio.`);
  return value;
}

function validTime(value: string): string {
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) throw new Error(`Hora inválida: ${value}`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function copyAtomic(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.tmp-${process.pid}`;
  await copyFile(source, temporary);
  await rename(temporary, destination);
}

function validateManifest(value: unknown): {
  releaseId: string;
  archive: { filename: string; sizeBytes: number; sha256: string };
  [key: string]: unknown;
} {
  if (!value || typeof value !== "object") throw new Error("Manifiesto inválido.");
  const manifest = value as Record<string, unknown>;
  const releaseId = String(manifest.releaseId ?? "");
  const archive = manifest.archive as Record<string, unknown> | undefined;
  if (
    manifest.schemaVersion !== 1 ||
    !/^[0-9]{8}[A-Za-z0-9._-]{1,80}$/.test(releaseId) ||
    !archive ||
    !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(String(archive.filename ?? "")) ||
    !Number.isSafeInteger(archive.sizeBytes) || Number(archive.sizeBytes) < 1 ||
    !/^[a-f0-9]{64}$/.test(String(archive.sha256 ?? "")) ||
    !Array.isArray(manifest.files) || !Array.isArray(manifest.migrations)
  ) {
    throw new Error("El manifiesto no cumple el contrato release-v1.");
  }
  return manifest as ReturnType<typeof validateManifest>;
}
