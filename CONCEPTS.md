# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Session

A named, isolated browser context driven through one background daemon. Every command targets a session (`--session <name>`); refs, tabs, and code-mode store values belong to it.

## Ref

A short handle such as `@e3` that a snapshot assigns to an element so later commands can target it without a selector. Refs are scoped to the session and refreshed by each snapshot.

## Code mode

Running a whole browser task as one JavaScript program (`agent-browser run`, or the MCP tool `agent_browser_run`) instead of one command per agent turn. The program calls ordinary commands, so it has the same reach and policies as the CLI. Related: Session, Site skill.

## Site skill

A skill that, besides its instructions, ships helper functions for one website that code-mode programs load by name. Helpers that send, post, or edit only prepare a draft unless the caller explicitly confirms.
