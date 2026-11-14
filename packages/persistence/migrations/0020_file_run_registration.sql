DROP INDEX app.file_resources_registration_idx;
CREATE UNIQUE INDEX file_resources_registration_idx ON app.file_resources
 (owner_user_id,owner_scope,COALESCE(project_id,'00000000-0000-0000-0000-000000000000'::uuid),
 COALESCE(run_id,'00000000-0000-0000-0000-000000000000'::uuid),local_file_id);
