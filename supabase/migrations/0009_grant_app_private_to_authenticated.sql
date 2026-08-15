-- create_voucher() is deliberately SECURITY INVOKER (so RLS still applies as
-- the calling user), which means its call into app_private.next_voucher_number()
-- also runs as the invoker, not the function owner. authenticated never got
-- schema-level USAGE on app_private, so that call failed outright with
-- "permission denied for schema app_private" — caught by an end-to-end smoke
-- test that actually invokes the RPC as a real authenticated user, not by
-- the build/lint/advisors passes, none of which exercise it that way.
grant usage on schema app_private to authenticated;
grant execute on all functions in schema app_private to authenticated;
alter default privileges in schema app_private grant execute on functions to authenticated;
