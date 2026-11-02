-- Migration 0006 — generic order events and print-ready customer artwork.
--
--  * `customization_assets.kind` gains 'artwork': the per-printable-area, print-ready file the shopper's
--    design is exported to (distinct from 'upload' = the shopper's own photo and 'preview' = a composite).
--  * `integration_events` now records ONE row per delivered event, which may carry several order lines:
--    the per-line outcome is stored in `results`, so a replay of the same event answers identically.
--
-- Safe to re-run (the constraint is dropped and re-added under the same name).

ALTER TABLE personalization.customization_assets
  DROP CONSTRAINT IF EXISTS customization_assets_kind_check;
ALTER TABLE personalization.customization_assets
  ADD CONSTRAINT customization_assets_kind_check CHECK (kind IN ('upload', 'preview', 'artwork'));

ALTER TABLE personalization.integration_events ADD COLUMN IF NOT EXISTS results jsonb;
ALTER TABLE personalization.integration_events ADD COLUMN IF NOT EXISTS line_count integer;
