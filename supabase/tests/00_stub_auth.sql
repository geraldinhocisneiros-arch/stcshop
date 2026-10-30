-- Simula o mínimo do Supabase (auth.users, auth.uid()) para rodar os testes num Postgres comum.
create schema auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
do $$ begin create role authenticated; exception when others then null; end $$;
