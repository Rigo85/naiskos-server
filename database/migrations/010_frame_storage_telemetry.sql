ALTER TABLE naiskos.frame_runtime
  ADD COLUMN disk_total_bytes bigint,
  ADD COLUMN disk_used_bytes bigint,
  ADD COLUMN disk_available_bytes bigint,
  ADD COLUMN disk_reserved_bytes bigint,
  ADD COLUMN frame_data_bytes bigint,
  ADD COLUMN media_data_bytes bigint;

ALTER TABLE naiskos.frame_runtime
  ADD CONSTRAINT frame_runtime_storage_nonnegative CHECK (
    (disk_total_bytes IS NULL OR disk_total_bytes >= 0) AND
    (disk_used_bytes IS NULL OR disk_used_bytes >= 0) AND
    (disk_available_bytes IS NULL OR disk_available_bytes >= 0) AND
    (disk_reserved_bytes IS NULL OR disk_reserved_bytes >= 0) AND
    (frame_data_bytes IS NULL OR frame_data_bytes >= 0) AND
    (media_data_bytes IS NULL OR media_data_bytes >= 0)
  );
