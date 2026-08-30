import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const VIDEO_MAX_DURATION_SECONDS = 120;
export const VIDEO_MAX_WIDTH = 1280;
export const VIDEO_MAX_HEIGHT = 800;

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  r_frame_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeDocument {
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
}

export interface VideoProbe {
  formatNames: string[];
  durationSeconds: number;
  sizeBytes: number;
  bitRate: number | null;
  video: {
    codec: string;
    profile: string | null;
    encodedWidth: number;
    encodedHeight: number;
    displayWidth: number;
    displayHeight: number;
    pixelFormat: string | null;
    frameRate: string | null;
    rotation: number;
  };
  audio: {
    codec: string;
    sampleRate: number | null;
    channels: number | null;
    channelLayout: string | null;
  } | null;
}

export interface VideoProcessingResult {
  source: VideoProbe;
  display: VideoProbe;
  posterTimestampSeconds: number;
}

export class RejectedVideoError extends Error {}

export async function inspectVideo(file: string): Promise<VideoProbe> {
  let document: ProbeDocument;
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration,size,bit_rate:stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels,channel_layout:stream_tags=rotate:stream_side_data=rotation",
      "-of",
      "json",
      file,
    ]);
    document = JSON.parse(stdout) as ProbeDocument;
  } catch (error) {
    throw new RejectedVideoError(
      `No se pudo inspeccionar o decodificar la estructura del video: ${errorMessage(error)}`,
    );
  }

  const videoStream = document.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  if (
    !videoStream?.codec_name ||
    !positiveInteger(videoStream.width) ||
    !positiveInteger(videoStream.height)
  ) {
    throw new RejectedVideoError("El archivo no contiene una pista de video válida.");
  }

  const durationSeconds = Number(document.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RejectedVideoError("No se pudo determinar la duración del video.");
  }

  const rotation = normalizedRotation(videoStream);
  const swapsDimensions = Math.abs(rotation) === 90;
  const audioStream = document.streams?.find(
    (stream) => stream.codec_type === "audio" && stream.codec_name,
  );
  return {
    formatNames: String(document.format?.format_name ?? "")
      .split(",")
      .filter(Boolean),
    durationSeconds,
    sizeBytes: finiteNumber(document.format?.size) ?? 0,
    bitRate: finiteNumber(document.format?.bit_rate),
    video: {
      codec: videoStream.codec_name,
      profile: videoStream.profile ?? null,
      encodedWidth: videoStream.width,
      encodedHeight: videoStream.height,
      displayWidth: swapsDimensions ? videoStream.height : videoStream.width,
      displayHeight: swapsDimensions ? videoStream.width : videoStream.height,
      pixelFormat: videoStream.pix_fmt ?? null,
      frameRate: videoStream.r_frame_rate ?? null,
      rotation,
    },
    audio: audioStream
      ? {
          codec: audioStream.codec_name!,
          sampleRate: finiteNumber(audioStream.sample_rate),
          channels: finiteNumber(audioStream.channels),
          channelLayout: audioStream.channel_layout ?? null,
        }
      : null,
  };
}

export async function createVideoRenditions(
  input: string,
  display: string,
  poster: string,
): Promise<VideoProcessingResult> {
  const source = await inspectVideo(input);
  if (source.durationSeconds > VIDEO_MAX_DURATION_SECONDS) {
    throw new RejectedVideoError("El video supera el límite de 2 minutos.");
  }

  await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    "-vf",
    `scale=${VIDEO_MAX_WIDTH}:${VIDEO_MAX_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-map_metadata",
    "-1",
    "-metadata:s:v:0",
    "rotate=0",
    "-movflags",
    "+faststart",
    display,
  ]);

  const normalized = await inspectVideo(display);
  validateNormalizedVideo(source, normalized);

  const posterTimestampSeconds = Math.min(1, source.durationSeconds / 2);
  await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    posterTimestampSeconds.toFixed(3),
    "-i",
    display,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    poster,
  ]);

  return { source, display: normalized, posterTimestampSeconds };
}

/**
 * Genera una orientación manual desde el MP4 normalizado de cero grados. No
 * depende de metadatos y vuelve a producir el póster correspondiente.
 */
export async function createRotatedVideoRenditions(
  normalizedInput: string,
  display: string,
  poster: string,
  rotationDegrees: 90 | 180 | 270,
): Promise<VideoProcessingResult> {
  const source = await inspectVideo(normalizedInput);
  const rotationFilter =
    rotationDegrees === 90
      ? "transpose=clock"
      : rotationDegrees === 270
        ? "transpose=cclock"
        : "hflip,vflip";
  await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    normalizedInput,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    "-vf",
    `${rotationFilter},scale=${VIDEO_MAX_WIDTH}:${VIDEO_MAX_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-map_metadata",
    "-1",
    "-metadata:s:v:0",
    "rotate=0",
    "-movflags",
    "+faststart",
    display,
  ]);

  const normalized = await inspectVideo(display);
  validateNormalizedVideo(source, normalized);
  const posterTimestampSeconds = Math.min(1, source.durationSeconds / 2);
  await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    posterTimestampSeconds.toFixed(3),
    "-i",
    display,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    poster,
  ]);
  return { source, display: normalized, posterTimestampSeconds };
}

function validateNormalizedVideo(source: VideoProbe, output: VideoProbe): void {
  if (!output.formatNames.includes("mp4")) {
    throw new Error("La variante normalizada no quedó en contenedor MP4.");
  }
  if (output.video.codec !== "h264" || output.video.pixelFormat !== "yuv420p") {
    throw new Error("La variante normalizada no quedó en H.264/yuv420p.");
  }
  if (output.video.rotation !== 0) {
    throw new Error("La variante normalizada todavía depende de metadatos de rotación.");
  }
  if (
    output.video.displayWidth > VIDEO_MAX_WIDTH ||
    output.video.displayHeight > VIDEO_MAX_HEIGHT ||
    output.video.displayWidth % 2 !== 0 ||
    output.video.displayHeight % 2 !== 0
  ) {
    throw new Error("La variante normalizada excede el perfil 1280x800 o tiene dimensiones impares.");
  }
  if (source.audio && output.audio?.codec !== "aac") {
    throw new Error("La pista de audio no quedó normalizada como AAC.");
  }
  if (source.audio && (output.audio?.sampleRate !== 48_000 || output.audio.channels !== 2)) {
    throw new Error("La pista de audio no quedó normalizada a 48 kHz estéreo.");
  }
  if (Math.abs(output.durationSeconds - source.durationSeconds) > 0.25) {
    throw new Error("La duración cambió de forma inesperada durante la normalización.");
  }
}

function normalizedRotation(stream: ProbeStream): number {
  const raw =
    stream.side_data_list?.find((entry) => Number.isFinite(entry.rotation))
      ?.rotation ?? finiteNumber(stream.tags?.rotate) ?? 0;
  const normalized = ((raw % 360) + 360) % 360;
  if (normalized === 90) return 90;
  if (normalized === 180) return 180;
  if (normalized === 270) return -90;
  return 0;
}

function finiteNumber(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
