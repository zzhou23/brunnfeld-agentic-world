# Brunnfeld Agentic World

Medieval village economy simulation with 20 LLM-driven agents, pixel-art viewer, and emergent behavior.

## Commands

```bash
# Install
npm install && cd viewer && npm install && cd ..

# Run
npm start              # Full simulation + viewer (port 3333)
npm run resume         # Continue from last tick
npm run tick           # Single tick then exit
npm run reset          # Wipe world_state.json, restore initial memories
npm run server         # HTTP server only (no simulation loop)
npm run viewer:dev     # Vite dev server (port 5173)

# Validate
npm run typecheck      # tsc --noEmit
npm run build          # tsc → dist/
npm run viewer:build   # vite build → viewer/dist/
```

## Key Paths

| Path | Purpose |
|------|---------|
| `src/engine.ts` | 14-phase simulation tick loop |
| `src/types.ts` | All type definitions (WorldState, AgentAction, etc.) |
| `src/agent-runner.ts` | Perception builder + LLM orchestration |
| `src/llm.ts` | Claude CLI + OpenRouter backends |
| `src/tools.ts` | Action schema + inline resolution |
| `src/index.ts` | CLI entry point |
| `src/server.ts` | HTTP server + SSE + API routes |
| `viewer/src/` | React + Vite + Zustand frontend |
| `data/world_state.json` | Live simulation state (mutated every tick) |
| `data/profiles/` | 20 agent background files (read-only .md) |
| `data/memory/` | Live agent memory (rebuilt every tick) |
| `data/memory_initial/` | Clean memory snapshot (for reset) |
| `data/logs/` | Per-tick JSON logs |

## Architecture

- **Backend:** TypeScript (Node.js ES2022), no framework (raw `http`)
- **Frontend:** React 18 + Vite 6 + Zustand 5, pixel-art canvas renderer
- **LLM:** Claude CLI (`child_process.spawn`) or OpenRouter API; semaphore-based concurrency (max 4)
- **Tick loop:** 14 phases per tick (dawn → perception → LLM → resolution → state write → SSE broadcast)
- **Config:** `.env` file (see `.env.example`)

## Conventions

- No test suite exists; validation is runtime simulation
- No linter/formatter configured
- Agent profiles in `data/profiles/*.md` are read-only source of truth
- `world_state.json` is the single mutable state file
- Upstream: `Dominien/brunnfeld-agentic-world`; fork: `zzhou23/brunnfeld-agentic-world`
