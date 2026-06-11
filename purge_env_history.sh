#!/bin/bash
# ── purge_env_history.sh ──────────────────────────────────────────────────
# Script per rimuovere completamente il file .env e le chiavi API dalla cronologia Git.

# Assicurati di essere nella root del progetto
cd "$(dirname "$0")"

# 1. Crea un backup del file .env locale
if [ -f .env ]; then
  echo "💾 Creazione backup temporaneo di .env..."
  cp .env ../.env_backup_temp
fi

# 2. Rimuove il file .env dall'indice Git corrente (se tracciato)
echo "🧹 Rimozione di .env dal tracciamento Git corrente..."
git rm --cached .env 2>/dev/null || true
git commit -m "chore: untrack .env file" 2>/dev/null || true

# 3. Riscrive la cronologia Git per rimuovere tutte le tracce di .env
echo "🚀 Riscrittura della cronologia Git (questo potrebbe richiedere tempo)..."
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch .env" \
  --prune-empty --tag-name-filter cat -- --all

# 4. Ripristina il file .env locale
if [ -f ../.env_backup_temp ]; then
  echo "🔄 Ripristino del file .env locale..."
  mv ../.env_backup_temp .env
fi

echo "================================================================="
echo "✅ Cronologia locale ripulita con successo!"
echo ""
echo "⚠️  IMPORTANTE: Per aggiornare GitHub ed eliminare le chiavi"
echo "   anche dal server remoto, esegui questo comando:"
echo ""
echo "   git push origin --force --all"
echo "================================================================="
