import { rm } from "node:fs/promises";

import sharp, { OutputInfo } from "sharp";

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 800;
export const PHOTO_WEBP_QUALITY = 88;
export const PHOTO_WEBP_EFFORT = 4;
export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 240;
export const THUMBNAIL_WEBP_QUALITY = 75;

export interface PhotoDisplayRecovery {
  strategy: "jpeg-warning-tolerant-decode";
  warning: string;
}

export interface PhotoDisplayMasterResult {
  info: OutputInfo;
  recovery: PhotoDisplayRecovery | null;
}

function photoDisplayPipeline(
  input: string,
  output: string,
  failOn: "warning" | "error",
): Promise<OutputInfo> {
  return sharp(input, { failOn })
    .rotate()
    .resize(FRAME_WIDTH, FRAME_HEIGHT, {
      fit: "outside",
      withoutEnlargement: true,
    })
    .webp({ quality: PHOTO_WEBP_QUALITY, effort: PHOTO_WEBP_EFFORT })
    .toFile(output);
}

function isJpegDecoderFailure(error: unknown): error is Error {
  return error instanceof Error && /^VipsJpeg:/u.test(error.message);
}

/**
 * Genera un maestro que conserva la fotografía completa y tiene píxeles
 * suficientes para alternar entre contain y cover en una pantalla 1280x800.
 * El recorte de cover ocurre sólo durante la presentación.
 */
export async function createPhotoDisplayMaster(
  input: string,
  output: string,
): Promise<PhotoDisplayMasterResult> {
  try {
    return {
      info: await photoDisplayPipeline(input, output, "warning"),
      recovery: null,
    };
  } catch (error) {
    if (!isJpegDecoderFailure(error)) throw error;

    // libvips trata las advertencias JPEG como errores de forma predeterminada.
    // El segundo intento sigue rechazando errores reales y datos truncados;
    // únicamente permite advertencias que el decodificador puede recuperar.
    await rm(output, { force: true });
    return {
      info: await photoDisplayPipeline(input, output, "error"),
      recovery: {
        strategy: "jpeg-warning-tolerant-decode",
        warning: error.message.slice(0, 500),
      },
    };
  }
}

/** Genera una variante rotada desde el maestro normalizado de cero grados. */
export async function createRotatedPhotoVariant(
  normalizedInput: string,
  output: string,
  rotationDegrees: 90 | 180 | 270,
): Promise<OutputInfo> {
  return sharp(normalizedInput)
    .rotate(rotationDegrees)
    .webp({ quality: PHOTO_WEBP_QUALITY, effort: PHOTO_WEBP_EFFORT })
    .toFile(output);
}

/**
 * Genera la única variante destinada a la cuadrícula. Parte siempre de un
 * display o póster ya normalizado; nunca vuelve a decodificar el original.
 */
export async function createMediaThumbnail(
  normalizedInput: string,
  output: string,
): Promise<OutputInfo> {
  return sharp(normalizedInput)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
      fit: "cover",
      position: "centre",
    })
    .webp({ quality: THUMBNAIL_WEBP_QUALITY, effort: PHOTO_WEBP_EFFORT })
    .toFile(output);
}
