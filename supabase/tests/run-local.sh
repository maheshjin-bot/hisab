#!/usr/bin/env bash
#
# Rebuild a throwaway database from supabase/migrations/*.sql and run the
# guarantees suite against it. See README.md in this directory.
#
#   bash supabase/tests/run-local.sh
#
# Exits non-zero on the first migration that will not apply or the first
# guarantee that does not hold, so it is usable as a CI gate.

set -euo pipefail

DB="${HISAB_TEST_DB:-hisab_verify}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER

# psql is not on PATH in a default Windows PostgreSQL install.
if ! command -v psql >/dev/null 2>&1; then
  for candidate in \
    "/c/Program Files/PostgreSQL/18/bin" \
    "/c/Program Files/PostgreSQL/17/bin" \
    "/c/Program Files/PostgreSQL/16/bin"
  do
    if [ -x "$candidate/psql.exe" ] || [ -x "$candidate/psql" ]; then
      PATH="$candidate:$PATH"
      export PATH
      break
    fi
  done
fi
command -v psql >/dev/null 2>&1 || {
  echo "psql not found. Add the PostgreSQL bin directory to PATH." >&2
  exit 1
}

# Run from the repo root regardless of where this was invoked.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> rebuilding $DB"
psql -d postgres -q -v ON_ERROR_STOP=1 \
  -c "drop database if exists $DB;" \
  -c "create database $DB;"

echo "==> applying the Supabase compatibility harness"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f supabase/tests/local-harness.sql

echo "==> applying migrations"
for f in supabase/migrations/*.sql; do
  printf '    %s ... ' "$(basename "$f")"
  if psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null; then
    echo ok
  else
    echo FAILED
    echo "" >&2
    echo "Migration $f did not apply. Re-run it on its own to see the error:" >&2
    echo "  psql -d $DB -v ON_ERROR_STOP=1 -f $f" >&2
    exit 1
  fi
done

echo "==> running supabase/tests/guarantees.sql"
psql "postgresql://$PGUSER@$PGHOST:$PGPORT/$DB" -v ON_ERROR_STOP=1 \
  -f supabase/tests/guarantees.sql

echo ""
echo "==> passed"
