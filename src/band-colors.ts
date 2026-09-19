import sharp from "sharp";

/** Small static palette from the COMPLETE normalized image/poster, never a cropped thumbnail. */
export async function extractBandColors(source: string): Promise<[string, string] | null> {
  try {
    const { data, info } = await sharp(source)
      .timeout({ seconds: 10 })
      .resize(32, 32, { fit: "fill" })
      .flatten({ background: "#000" }).toColourspace("srgb").removeAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const halves = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (let y = 0; y < info.height; y += 1) {
      const sum = halves[y < info.height / 2 ? 0 : 1]!;
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        for (let c = 0; c < 3; c += 1) sum[c] = sum[c]! + data[offset + c]!;
        sum[3] = sum[3]! + 1;
      }
    }
    // Muted, darker shades keep bands unobtrusive. Never used to change the actual media.
    return halves.map((sum) => {
      const rgb = sum.slice(0, 3).map((n) => n / sum[3]!);
      const grey = (rgb[0]! + rgb[1]! + rgb[2]!) / 3;
      return "#" + rgb.map((n) => Math.round((n * 0.8 + grey * 0.2) * 0.65)
        .toString(16).padStart(2, "0")).join("");
    }) as [string, string];
  } catch {
    // This enrichment is deliberately non-fatal. Missing color renders black.
    console.warn(JSON.stringify({ event: "media.band-colors.unavailable" }));
    return null;
  }
}
