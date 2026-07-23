ALTER TABLE Photo ADD COLUMN file_hash TEXT;
ALTER TABLE Photo ADD COLUMN phash TEXT;
CREATE INDEX IF NOT EXISTS idx_photo_file_hash ON Photo(file_hash);
CREATE INDEX IF NOT EXISTS idx_photo_phash ON Photo(phash);
