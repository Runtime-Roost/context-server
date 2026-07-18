#!/usr/bin/env bash

set -Eeuo pipefail

readonly DB_NAME="personal_context"
readonly MAINTENANCE_DB="${PGMAINTENANCE_DB:-postgres}"

usage() {
    cat <<'EOF'
Usage: scripts/db.sh <command> [--force]

Manage the local PostgreSQL database used by personal-context-server.

Commands:
  create          Create the database if it does not exist
  drop            Drop the database after confirmation
  reset           Drop and recreate the database after confirmation
  status          Show whether the database exists and is reachable
  shell           Open a psql shell connected to the database
  help            Show this help

Options:
  --force         Skip confirmation for drop or reset

Standard libpq environment variables such as PGHOST, PGPORT, PGUSER, and
PGPASSWORD are honored. PGDATABASE is intentionally ignored because this
helper always manages the "personal_context" database.
EOF
}

require_postgres_tools() {
    local tool

    for tool in psql createdb dropdb; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            printf 'Error: %s is not installed or is not on PATH.\n' "$tool" >&2
            exit 127
        fi
    done
}

database_exists() {
    local result

    if ! result="$(
        psql \
            --dbname "$MAINTENANCE_DB" \
            --set ON_ERROR_STOP=1 \
            --tuples-only \
            --no-align \
            --command "SELECT 1 FROM pg_database WHERE datname = 'personal_context';"
    )"; then
        printf 'Error: could not connect to PostgreSQL maintenance database "%s".\n' \
            "$MAINTENANCE_DB" >&2
        return 2
    fi

    [[ "$result" == "1" ]]
}

create_database() {
    local status=0

    if database_exists; then
        printf 'Database "%s" already exists.\n' "$DB_NAME"
        return
    else
        status=$?
    fi

    if [[ "$status" -ne 1 ]]; then
        return "$status"
    fi

    createdb --maintenance-db "$MAINTENANCE_DB" "$DB_NAME"
    printf 'Created database "%s".\n' "$DB_NAME"
}

confirm_destructive_action() {
    local action="$1"

    if [[ "${FORCE:-false}" == "true" ]]; then
        return
    fi

    if [[ ! -t 0 ]]; then
        printf 'Error: %s requires an interactive terminal or --force.\n' "$action" >&2
        exit 2
    fi

    local answer
    read -r -p "$action database \"$DB_NAME\"? This deletes its data. [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || {
        printf 'Cancelled.\n'
        exit 0
    }
}

drop_database() {
    local status=0

    database_exists || status=$?

    if [[ "$status" -eq 2 ]]; then
        return "$status"
    fi

    if [[ "$status" -eq 1 ]]; then
        printf 'Database "%s" does not exist.\n' "$DB_NAME"
        return
    fi

    confirm_destructive_action "Drop"
    dropdb --maintenance-db "$MAINTENANCE_DB" --force "$DB_NAME"
    printf 'Dropped database "%s".\n' "$DB_NAME"
}

show_status() {
    local status=0

    if database_exists; then
        printf 'Database "%s" exists and PostgreSQL is reachable.\n' "$DB_NAME"
        psql --dbname "$DB_NAME" --set ON_ERROR_STOP=1 --command '\conninfo'
    else
        status=$?

        if [[ "$status" -eq 1 ]]; then
            printf 'Database "%s" does not exist (PostgreSQL is reachable).\n' "$DB_NAME"
            return 1
        else
            return "$status"
        fi
    fi
}

open_shell() {
    local status=0

    database_exists || status=$?

    if [[ "$status" -ne 0 ]]; then
        if [[ "$status" -eq 1 ]]; then
            printf 'Error: database "%s" does not exist. Run "%s create" first.\n' \
                "$DB_NAME" "$0" >&2
        fi

        return "$status"
    fi

    exec psql --dbname "$DB_NAME"
}

main() {
    local command="${1:-help}"
    FORCE=false

    if [[ "${2:-}" == "--force" ]]; then
        FORCE=true
    elif [[ -n "${2:-}" ]]; then
        printf 'Error: unknown option: %s\n\n' "$2" >&2
        usage >&2
        exit 2
    fi

    if [[ $# -gt 2 ]]; then
        printf 'Error: too many arguments.\n\n' >&2
        usage >&2
        exit 2
    fi

    case "$command" in
        help|-h|--help)
            usage
            ;;
        create)
            require_postgres_tools
            create_database
            ;;
        drop)
            require_postgres_tools
            drop_database
            ;;
        reset)
            require_postgres_tools
            confirm_destructive_action "Reset"
            FORCE=true
            drop_database
            create_database
            ;;
        status)
            require_postgres_tools
            show_status
            ;;
        shell)
            require_postgres_tools
            open_shell
            ;;
        *)
            printf 'Error: unknown command: %s\n\n' "$command" >&2
            usage >&2
            exit 2
            ;;
    esac
}

main "$@"
