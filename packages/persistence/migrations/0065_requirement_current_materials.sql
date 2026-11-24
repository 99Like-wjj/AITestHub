ALTER TABLE app.requirements
  ADD COLUMN material_lock_version_id uuid,
  ADD COLUMN material_locked_at timestamptz,
  ADD COLUMN material_locked_by uuid REFERENCES app.users(id),
  ADD COLUMN predecessor_requirement_id uuid,
  ADD COLUMN predecessor_version_id uuid,
  ADD CONSTRAINT requirement_material_lock_shape CHECK (
    (material_lock_version_id IS NULL AND material_locked_at IS NULL AND material_locked_by IS NULL)
    OR (material_lock_version_id IS NOT NULL AND material_locked_at IS NOT NULL)
  ),
  ADD CONSTRAINT requirement_material_lock_version_fk
    FOREIGN KEY (project_id, id, material_lock_version_id)
    REFERENCES app.requirement_versions(project_id, requirement_id, id),
  ADD CONSTRAINT requirement_predecessor_shape CHECK (
    (predecessor_requirement_id IS NULL AND predecessor_version_id IS NULL)
    OR (predecessor_requirement_id IS NOT NULL AND predecessor_version_id IS NOT NULL AND predecessor_requirement_id <> id)
  ),
  ADD CONSTRAINT requirement_predecessor_version_fk
    FOREIGN KEY (project_id, predecessor_requirement_id, predecessor_version_id)
    REFERENCES app.requirement_versions(project_id, requirement_id, id);

CREATE INDEX requirements_predecessor_idx
  ON app.requirements(project_id, predecessor_requirement_id)
  WHERE predecessor_requirement_id IS NOT NULL;

-- Historical associations, including removed assets and former API scenario
-- associations, count as use. The first historical lock itself was not recorded.
WITH used_requirements AS (
  SELECT DISTINCT v.requirement_id
  FROM app.asset_revisions a
  JOIN app.requirement_versions v
    ON v.project_id=a.project_id AND v.id=a.requirement_version_id
), current_materials AS (
  SELECT DISTINCT ON (v.requirement_id) v.requirement_id,v.id
  FROM app.requirement_versions v
  JOIN used_requirements u ON u.requirement_id=v.requirement_id
  ORDER BY v.requirement_id,v.version_no DESC
)
UPDATE app.requirements r
SET material_lock_version_id=v.id,material_locked_at=clock_timestamp()
FROM current_materials v WHERE v.requirement_id=r.id;

CREATE FUNCTION app.guard_requirement_material_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.material_lock_version_id IS NOT NULL AND (
    NEW.material_lock_version_id IS DISTINCT FROM OLD.material_lock_version_id
    OR NEW.material_locked_at IS DISTINCT FROM OLD.material_locked_at
    OR NEW.material_locked_by IS DISTINCT FROM OLD.material_locked_by
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.business_number IS DISTINCT FROM OLD.business_number
  ) THEN
    RAISE EXCEPTION 'locked requirement material and identity are immutable';
  END IF;
  IF NEW.predecessor_requirement_id IS DISTINCT FROM OLD.predecessor_requirement_id
    OR NEW.predecessor_version_id IS DISTINCT FROM OLD.predecessor_version_id THEN
    RAISE EXCEPTION 'requirement predecessor is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER requirement_material_lock_immutable
  BEFORE UPDATE OF material_lock_version_id,material_locked_at,material_locked_by,
    title,business_number,predecessor_requirement_id,predecessor_version_id
  ON app.requirements FOR EACH ROW EXECUTE FUNCTION app.guard_requirement_material_lock();

ALTER TABLE app.asset_revisions ADD COLUMN basis_requirement_version_id uuid,
  ADD CONSTRAINT asset_revision_requirement_basis_fk
  FOREIGN KEY (project_id,basis_requirement_version_id)
  REFERENCES app.requirement_versions(project_id,id);

CREATE INDEX asset_revisions_requirement_basis_idx
  ON app.asset_revisions(project_id,basis_requirement_version_id)
  WHERE basis_requirement_version_id IS NOT NULL;
