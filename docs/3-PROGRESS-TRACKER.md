# Tracker di Progresso per l'Implementazione SOTA

Questo documento tiene traccia dello stato di avanzamento delle funzionalità descritte nel `2-IMPLEMENTATION-PLAN.md`.

## Fase 1: Event-Driven Foundation & Execution Modes
- [ ] **1.1** Sostituire le promise chains legacy in `hydra-loop.mjs` con una classe `EventStream` centrale.
- [ ] **1.2** Implementare i listener per le tipologie base: `Action`, `Observation`, `Thought`.
- [ ] **1.3** Aggiungere il comando Telegram `/mode sequential` e `/mode parallel`.
- [ ] **1.4** Esporre il toggle di Execution Mode nella Dashboard Web.
- [ ] **1.5** Adattare il `TaskManager` per comportarsi come un job queue dinamico in base alla modalità scelta.

## Fase 2: Docker Runtime Sandboxing
- [ ] **2.1** Scrivere `Dockerfile.sandbox` installando Node/Python/Go ed un micro-server HTTP (Runtime Client).
- [ ] **2.2** Implementare il controller nel Bridge (host) per instradare le `Action` al Runtime Client (REST API).
- [ ] **2.3** Aggiornare modulo `safety.mjs` per disabilitare esecuzione host e forzare i comandi in container.
- [ ] **2.4** Configurare Volume Mount in sicurezza (solo directory di lavoro del task specifico).

## Fase 3: RAG Semantico "AST-Aware" & Hybrid Search
- [ ] **3.1** Installare ed integrare `tree-sitter` (o parser simile) per analizzare la struttura AST dei file JS/TS/PY.
- [ ] **3.2** Scrivere il modulo di chunking intelligente che non spezza mai blocchi sintattici.
- [ ] **3.3** Integrare un Vector DB locale (ChromaDB o LlamaIndex) ed un motore di ricerca lessicale (BM25).
- [ ] **3.4** Sviluppare il proxy di Hybrid Search che unisce e riordina (Reciprocal Rank Fusion) i risultati.
- [ ] **3.5** Implementare LiteLLM Tool Calling per fornire gli strumenti `search_codebase(query)` e `read_ast`.

## Fase 4: Hierarchical Self-Reflection Loop
- [ ] **4.1** Disabilitare il rollback distruttivo in `hydra-loop.mjs` in caso di `qa.passed = false`.
- [ ] **4.2** Catturare l'`Observation` d'errore (stderr dal docker container).
- [ ] **4.3** Creare un prompt di Patcher ed un sub-agente capace di sputare fuori file formato Unified Diff.
- [ ] **4.4** Integrare libreria Node.js per applicare diff in modo deterministico sul workspace temporaneo.
- [ ] **4.5** Implementare breaker logico (max 3 loop inner prima di fallback ad outer loop).

## Fase 5: Parallelismo DAG (Abilitato via Toggle)
- [ ] **5.1** Riscrivere `task-manager.mjs` per processare array complessi di dipendenze incrociate (DAG).
- [ ] **5.2** Spostare il coordinamento in pool di worker asincroni concorrenti.
- [ ] **5.3** Creazione dinamica isolata di branch git (`hydra/task-N`) per ogni istanza concorrente.
- [ ] **5.4** Implementare agente specializzato "Merge Conflict Resolver" basato su marcatori Git.
