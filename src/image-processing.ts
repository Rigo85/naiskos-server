import sharp, { OutputInfo } from "sharp";

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 800;
export const PHOTO_WEBP_QUALITY = 88;
export const PHOTO_WEBP_EFFORT = 4;
export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 240;
export const THUMBNAIL_WEBP_QUALITY = 75;

/**
 * Genera un maestro que conserva la fotografía completa y tiene píxeles
 * suficientes para alternar entre contain y cover en una pantalla 1280x800.
 * El recorte de cover ocurre sólo durante la presentación.
 */
export async function createPhotoDisplayMaster(
  input: string,
  output: string,
): Promise<OutputInfo> {
  return sharp(input)
    .rotate()
    .resize(FRAME_WIDTH, FRAME_HEIGHT, {
      fit: "outside",
      withoutEnlargement: true,
    })
    .webp({ quality: PHOTO_WEBP_QUALITY, effort: PHOTO_WEBP_EFFORT })
    .toFile(output);
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
