#!/bin/bash
set -e

# On créé l'utilisateur de réplication
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER repl WITH REPLICATION ENCRYPTED PASSWORD 'repl_pwd';
EOSQL

# On permet les connexions pour la réplication
echo "host replication repl all md5" >> /var/lib/postgresql/data/pg_hba.conf
