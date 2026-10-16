# ADR 0003: OpenCode Integration Model

- Status: Accepted
- Date: 2026-10-16

## Context
Sparkiee needs to react to coding tasks without inspecting private implementation details or making permission decisions on behalf of the user.

## Decision
Create a thin OpenCode plugin using the officially supported event subscription API (`ctx.event.subscribe()` as identified during Phase 0). The plugin translates source events into a small shared protocol; core owns normalization, deduplication, and multi-session state.

## Rules

- Never auto-approve permissions.
- Do not infer task success from an idle event alone.
- Do not invent progress percentages.
- Do not forward prompts, source code, or secrets to the dashboard.
- Keep the adapter optional and fail safely if the plugin or daemon is unavailable.

## Consequences

The event mapping will be tested against the installed OpenCode version during the integration phase. This ADR does not claim that the adapter is already implemented.
