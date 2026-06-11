# Piano di Implementazione Capillare SOTA

Questo documento definisce l'esecuzione tecnica, passo dopo passo, basandosi sullo studio dell'arte (OpenHands, Sweep AI).

---

## Fase 1: Event-Driven Foundation & Execution Modes
*Passaggio dalla state machine legacy a un sistema ad eventi, introducendo il controllo utente sulla concorrenza.*

*   **Step 1.1: Refactoring Architetturale Event Stream**
    *   Rimuovere le pipeline sequenziali hardcoded in `hydra-loop.mjs`.
    *   Creare una classe `EventStream` (append-only log) che gestisce la propagazione di eventi `Action`, `Observation`, e `Thought` in tutto il sistema.
*   **Step 1.2: Implementazione Toggle Sequenziale/Parallelo**
    *   Aggiungere nel bot Telegram i comandi `/mode sequential` e `/mode parallel`.
    *   Aggiungere endpoint API per la Dashboard per fare il toggle.
    *   Configurare il `TaskManager` per leggere questa impostazione: se sequenziale, processa la coda 1-a-1; se parallela, delega al DAG scheduler.

## Fase 2: Docker Runtime Sandboxing (Metodo OpenHands)
*Isolamento dell'esecuzione del codice per sicurezza totale.*

*   **Step 2.1: Sviluppo del "Runtime Client" in Container**
    *   Creare un'immagine Docker base. Al suo interno, installare un micro-server (es. un mini server Fastify o Flask) che esponga l'API `/execute` per eseguire comandi shell.
*   **Step 2.2: Integrazione in AgentRuntime**
    *   Il Bridge Node.js non usa più `execSync`. Usa il demone Docker dell'host per lanciare i container e invia richieste HTTP al Runtime Client per azionare comandi, leggere/scrivere file.
    *   Gestire lo stream WebSocket per catturare l'output del terminale in tempo reale.

## Fase 3: RAG Semantico "AST-Aware" & Hybrid Search (Metodo Sweep AI)
*Comprensione profonda del monorepo.*

*   **Step 3.1: Parsing con Tree-Sitter**
    *   Integrare la libreria `tree-sitter` in un nuovo modulo `lib/ast-indexer.mjs`.
    *   Configurare il parser per estrarre blocchi di codice logici (classi, costruttori, metodi) invece di tagliare il testo a casaccio.
*   **Step 3.2: Motore di Ricerca Ibrido**
    *   Implementare *Vector Search* (es. tramite un microservizio locale basato su ChromaDB e embeddings BGE).
    *   Implementare *Lexical Search* (BM25) per matching esatto di nomi variabili/classi.
    *   Unire i risultati (es. via Reciprocal Rank Fusion) ed esporre all'LLM i tool `search_codebase` e `read_ast_node`.

## Fase 4: Hierarchical Self-Reflection & Patcher Agent
*Correzione autonoma e granulare degli errori.*

*   **Step 4.1: Intercettazione `Observation` di errore**
    *   Se l'esito di un `npm run test` dal Docker Runtime è codice `> 0`, non eseguire il git reset.
*   **Step 4.2: Patcher Sub-Agent**
    *   Passare l'errore e il file incriminato a un agent secondario specializzato in patching.
    *   Generare output in formato "Unified Diff". Utilizzare una libreria robusta (es. `diff` su npm) per applicare la patch. Implementare un `max_retries=3` interno prima del fallimento globale.

## Fase 5: Parallelismo DAG e Resolver
*Abilitazione della scalabilità orizzontale in "Parallel Mode".*

*   **Step 5.1: Dependency Analyzer**
    *   Costruire il grafo delle dipendenze a partire dal file `prd.json`.
*   **Step 5.2: Multi-Branch & Multi-Container**
    *   Per ogni nodo indipendente, istanziare un nuovo branch `hydra/task-X` ed avviare un container Docker dedicato.
*   **Step 5.3: Intelligent Merge Conflict Resolver**
    *   In fase di rientro nel ramo `main`, se avviene una collisione (git conflict), far intervenire un agente LLM capace di leggere i marcatori di conflitto, capire i context AST e proporre una soluzione logica.
