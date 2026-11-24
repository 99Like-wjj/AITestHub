-- Catalog organization policy is mutable; executable inherited actions belong
-- to the published interface revision, never to the current directory view.
ALTER TABLE app.api_catalog_nodes
  ADD COLUMN stage_settings jsonb NOT NULL DEFAULT '{"pre":[],"post":[],"suppress":[]}'::jsonb,
  ADD CONSTRAINT api_catalog_directory_stage_shape CHECK (
    jsonb_typeof(stage_settings) = 'object'
    AND (kind <> 'interface' OR stage_settings = '{"pre":[],"post":[],"suppress":[]}'::jsonb)
  );

ALTER TABLE app.api_interface_revisions
  ADD COLUMN stage_providers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT api_catalog_stage_providers_array CHECK (
    jsonb_typeof(stage_providers) = 'array'
  );

