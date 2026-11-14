#!/bin/bash
set -euo pipefail
export MYSQL_PWD="$(cat /run/secrets/target_mysql_root_password)"
task_app_password="$(cat /run/secrets/target_mysql_app_password)"
task_cleanup_password="$(cat /run/secrets/target_mysql_cleanup_password)"
[[ "$task_app_password" =~ ^[a-f0-9]{64}$ && "$task_cleanup_password" =~ ^[a-f0-9]{64}$ ]]
mysql --user=root --database=aitesthub_target >/dev/null 2>&1 <<SQL
CREATE TABLE test_objects(id varchar(200) PRIMARY KEY,tenant_id varchar(200) NOT NULL,payload text NOT NULL);
CREATE USER 'ath_target_app'@'%' IDENTIFIED BY '$task_app_password';
CREATE USER 'ath_target_cleanup'@'%' IDENTIFIED BY '$task_cleanup_password';
GRANT SELECT,INSERT,UPDATE,DELETE ON aitesthub_target.test_objects TO 'ath_target_app'@'%';
GRANT DELETE ON aitesthub_target.test_objects TO 'ath_target_cleanup'@'%';
GRANT SELECT(id,tenant_id) ON aitesthub_target.test_objects TO 'ath_target_cleanup'@'%';
-- Enable the target audit only after credential-creating statements have completed.
SET PERSIST log_output='TABLE';
SET PERSIST general_log='ON';
CREATE SQL SECURITY DEFINER VIEW cleanup_call_count AS SELECT count(*) calls FROM mysql.general_log
  WHERE command_type='Execute' AND user_host LIKE 'ath_target_cleanup%' AND argument LIKE 'DELETE FROM%';
GRANT SELECT ON aitesthub_target.cleanup_call_count TO 'ath_target_app'@'%';
SQL
unset MYSQL_PWD task_app_password task_cleanup_password
