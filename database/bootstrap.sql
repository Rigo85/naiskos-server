\set ON_ERROR_STOP on

-- Ejecutar como administrador de PostgreSQL:
-- psql -v naiskos_owner_password='...' -v naiskos_app_password='...' -f database/bootstrap.sql postgres

SELECT format('CREATE ROLE naiskos_owner LOGIN PASSWORD %L', :'naiskos_owner_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'naiskos_owner') \gexec

SELECT format('CREATE ROLE naiskos_app LOGIN PASSWORD %L CONNECTION LIMIT 10', :'naiskos_app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'naiskos_app') \gexec

SELECT 'CREATE ROLE naiskos_readonly NOLOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'naiskos_readonly') \gexec

SELECT 'CREATE DATABASE naiskos OWNER naiskos_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'naiskos') \gexec

REVOKE CONNECT ON DATABASE naiskos FROM PUBLIC;
GRANT CONNECT ON DATABASE naiskos TO naiskos_owner, naiskos_app, naiskos_readonly;
