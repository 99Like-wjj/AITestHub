#!/bin/bash
set -euo pipefail
export AITESTHUB_TARGET_APP_PASSWORD="$(cat /run/secrets/target_postgres_app_password)"
export AITESTHUB_TARGET_CLEANUP_PASSWORD="$(cat /run/secrets/target_postgres_cleanup_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null 2>&1 <<'SQL'
\getenv app_password AITESTHUB_TARGET_APP_PASSWORD
\getenv cleanup_password AITESTHUB_TARGET_CLEANUP_PASSWORD
CREATE ROLE ath_target_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE ath_target_cleanup LOGIN PASSWORD :'cleanup_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE TABLE public.test_objects(id text PRIMARY KEY,tenant_id text NOT NULL,payload text NOT NULL DEFAULT 'synthetic');
CREATE TABLE public.delete_stats(role_name text PRIMARY KEY,calls bigint NOT NULL DEFAULT 0);
CREATE FUNCTION public.audit_delete_statement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.delete_stats(role_name,calls) VALUES(session_user,1)
    ON CONFLICT(role_name) DO UPDATE SET calls=delete_stats.calls+1;
  RETURN NULL;
END;
$$;
CREATE TRIGGER count_delete_statement AFTER DELETE ON public.test_objects FOR EACH STATEMENT EXECUTE FUNCTION public.audit_delete_statement();
REVOKE ALL ON FUNCTION public.audit_delete_statement() FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ath_target_app,ath_target_cleanup;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.test_objects TO ath_target_app;
GRANT DELETE ON public.test_objects TO ath_target_cleanup;
GRANT SELECT(id,tenant_id) ON public.test_objects TO ath_target_cleanup;
SQL
unset AITESTHUB_TARGET_APP_PASSWORD AITESTHUB_TARGET_CLEANUP_PASSWORD
