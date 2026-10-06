-- Close Supabase's automatic REST API (PostgREST) over this schema.
--
-- The bot reaches the database directly as `postgres`, the owner of every
-- table, which bypasses row-level security; nothing here uses the REST API.
-- But Supabase grants its API roles `anon` and `authenticated` full rights on
-- every table in `public`, so with RLS off anyone holding the project URL and
-- its anon key could read, change or delete the family's data (Supabase's
-- advisor: rls_disabled_in_public).
--
-- RLS on, with no policies, refuses those roles every row; the grants are
-- taken back as well, and taken away from tables made later — so a future
-- migration that forgets RLS still exposes nothing.

DO $$
DECLARE
  t record;
  r text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  -- The API roles exist only on Supabase; a plain Postgres has nothing to revoke.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;
