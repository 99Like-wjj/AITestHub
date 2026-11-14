#!/bin/bash
set -euo pipefail
# No secret is embedded in SQL, command arguments or output.
export AITESTHUB_INIT_APP_PASSWORD="$(cat /run/secrets/postgres_app_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password AITESTHUB_INIT_APP_PASSWORD
CREATE ROLE aitesthub_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE SCHEMA app AUTHORIZATION aitesthub_app;
GRANT CONNECT, TEMPORARY ON DATABASE aitesthub TO aitesthub_app;
ALTER ROLE aitesthub_app IN DATABASE aitesthub SET search_path = app, public;
SQL
unset AITESTHUB_INIT_APP_PASSWORD
