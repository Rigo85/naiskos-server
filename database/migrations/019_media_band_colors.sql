-- Optional, derived from normalized photos / video posters. Existing media remain valid.
ALTER TABLE naiskos.media_variants ADD COLUMN band_colors jsonb;
ALTER TABLE naiskos.media_variants ADD CONSTRAINT media_band_colors_valid CHECK (
  band_colors IS NULL OR (
    jsonb_typeof(band_colors) = 'array' AND jsonb_array_length(band_colors) = 2
    AND (band_colors->>0) ~ '^#[0-9a-f]{6}$' AND (band_colors->>1) ~ '^#[0-9a-f]{6}$'
  )
);
