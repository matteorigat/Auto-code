# Architettura SOTA (State-of-the-Art) Target

Questo documento definisce l'architettura target per `opencode-bridge-telegram`, evolvendolo da "loop sequenziale locale" a una piattaforma SOTA di "Agente Autonomo Distribuito e Sicuro", ispirata profondamente dai pattern di **OpenHands** (Event Stream, Docker Runtime) e **Sweep AI** (AST-Aware Hybrid RAG).

## 1. Modello Architetturale: Event-Driven & Execution Modes

### Architettura Legacy
Il sistema attuale usa una State Machine sequenziale e rigida (`IDLE` -> `PLAN` -> `EXEC`), limitata ad eseguire un task alla volta.

### Architettura SOTA Target
Il cuore diventerà un **Event Stream Architetturale (Append-Only Log)** (ispirato ad OpenHands).
*   Agenti, ambiente e UI comunicheranno unicamente scambiandosi eventi tipizzati (`Action`, `Observation`, `Thought`).
*   **Execution Mode Toggle (Sequenziale vs Parallelo)**: L'utente avrà il pieno controllo sull'orchestrazione. Tramite comandi Telegram (es. `/mode sequential` o `/mode parallel`) o tramite interruttore sulla Dashboard Web, il `TaskManager` adatterà il flusso:
    *   **Modalità Sequenziale**: Come l'attuale, ma potenziata dalla sandbox. Utile per debug, compiti che richiedono l'attenzione dell'utente passo-passo, o LLM locali con basse risorse.
    *   **Modalità Parallela (DAG)**: Analizza le dipendenze in `prd.json`. Stacca rami git multipli (`hydra/task-1`, `hydra/task-2`), istanzia worker concorrenti su container isolati e, infine, usa un "Conflict Resolver Agent" per unire il codice su `main`.

## 2. Esecuzione del Codice: Docker Runtime (Client-Server Sandboxing)

### Architettura Legacy
Esecuzione di `execSync` grezzo sull'host, esponendo a vulnerabilità.

### Architettura SOTA Target
Implementazione di un **Docker Runtime isolato**:
*   Verrà creato un container Docker "worker". All'interno del container girerà un micro-server HTTP (Runtime Client).
*   Il Bridge Node.js invierà le `Action` (es. "esegui `npm run build`", "leggi file `src/index.js`") al container tramite API REST, ricevendo `Observation` (stdout/stderr).
*   Questo garantisce portabilità totale (cloud o locale), limiti di risorse (RAM/CPU via cgroups) ed estrema sicurezza, confinando comandi distruttivi.

## 3. Gestione della Memoria e RAG: AST-Aware Hybrid Indexing

### Architettura Legacy
Iniezione statica di file concatenati (`progress.txt`), che distrugge la context window e spesso perde il contesto gerarchico del codice.

### Architettura SOTA Target (Ispirato a Sweep AI)
L'agente deve comprendere la codebase come un "Sviluppatore Junior":
*   **AST Chunking**: Invece di dividere i file per numero di caratteri, utilizzeremo parser sintattici (es. `tree-sitter`) per frammentare la codebase mantenendo intatte funzioni, classi e logica strutturale.
*   **Motore di Ricerca Ibrido**: L'agente disporrà di tool avanzati (`search_codebase(query)`). La ricerca non sarà solo Vettoriale (che rischia di perdersi nomi di variabili esatti), ma Ibrida (Vector Similarity + BM25 Lexical Search).
*   L'agente caricherà nel prompt *solo* i blocchi AST rilevanti, azzerando le allucinazioni e riducendo il costo/token.

## 4. Ciclo di Correzione: Hierarchical Self-Reflection Loop

### Architettura SOTA Target
Invece di rollback drastici su fallimento QA:
*   Si innesca un "Inner Loop". Il container restituisce un `Observation` di errore test/lint.
*   L'agente non riscrive l'intero file. Riceve l'errore e il file corrente, generando un "Unified Diff" (patch).
*   Questa patch viene applicata in sicurezza sul file system tramite parser. Se fallisce dopo `N` tentativi, scatta il rollback (Outer Loop).

## 5. Interazione Umana: Dashboard WebSockets Real-Time

### Architettura SOTA Target
Telegram rimane per notifiche asincrone, ma il controllo profondo si sposta su una Web UI avanzata:
*   L'Event Stream nativo verrà inviato tramite WebSockets alla Dashboard in tempo reale.
*   **Terminal View**: Streaming live degli stdout del container Docker.
*   **Agent Thoughts**: Visualizzazione dei blocchi `<thought>` mentre il modello ragiona.
*   **Controllo UI**: Interruttori per le Execution Modes (Sequenziale/Parallela), pulsanti di approvazione manuale e Code Editor live per correzioni umane al volo.
