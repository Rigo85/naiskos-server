ALTER TABLE naiskos.media_variants
  DROP CONSTRAINT media_variants_purpose_check;

ALTER TABLE naiskos.media_variants
  ADD CONSTRAINT media_variants_purpose_check
  CHECK (purpose IN ('original', 'display', 'poster', 'thumbnail'));

ALTER TABLE naiskos.frame_media
  ADD COLUMN thumbnail_variant_id uuid REFERENCES naiskos.media_variants(id);

CREATE INDEX frame_media_thumbnail_variant_idx
  ON naiskos.frame_media (thumbnail_variant_id)
  WHERE thumbnail_variant_id IS NOT NULL;
