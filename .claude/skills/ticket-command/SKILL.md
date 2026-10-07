---
name: ticket-command
description: Write or debug a ticket command, the user-owned script that gives Forest's ticket column its status card. Use when someone wants ticket status for Jira, Linear, GitHub issues, Shipyard or any other tracker, when a ticket dot never appears, or when touching tickets.ts or ticketInfo in parse.ts.
---

# Ticket commands

Forest names no tracker. A worktree's ticket key (`ROM-123`, `#45`) comes from
its branch, PR title or last commit (`ticketFor` in `parse.ts`); its status
comes from a command the user owns, set per repo in `~/.forest/settings.json`:

```json
{ "ticketCmds": { "twilight": "~/.forest/shipyard-ticket.sh", "*": "~/.forest/jira-ticket.sh" } }
```

`tickets.ts` runs it as `sh -c '<cmd> "$1"' forest-ticket <key>` in the repo's
main checkout, at most 4 at a time, again after `ticketPollMs` (5 min). Write
`"$1"` yourself to put the key somewhere else in the command.

## Contract

- **In:** the key as `$1`, exactly as shown (`ROM-123` upper-cased, `#45` with
  its `#`). Nothing else: no env vars, no stdin.
- **Out:** one JSON object on stdout:

  ```json
  { "title": "Fix login", "status": "In QA", "category": "indeterminate", "assignee": "Jake" }
  ```

  `status` is the tracker's own word, shown verbatim. `category` picks the dot
  color through `CATEGORY` in `parse.ts`; omit it if `status` is already one of
  those words. Every field is optional; extra fields are dropped.
- **Failure:** exit non-zero. Forest keeps the last good status, retries in
  10 min, and logs the first failure per repo to the server console.
- **Speed:** under ~2 s. It runs once per ticket per poll, so prefer a cached
  token over a login round-trip.

| category | words that map to it |
|---|---|
| todo | `new` `todo` `backlog` `triage` `unstarted` `open` |
| doing | `indeterminate` `started` `in_progress` `in_review` |
| done | `done` `completed` `closed` `merged` |
| canceled | `canceled` `cancelled` |

A tracker with other words: map them in `jq`, or add them to `CATEGORY` with a
case in `parse_test.ts` if they're common to a whole tracker.

## Rules

- **Auth stays where it is**: a CLI's own login (`gh`, `acli`), the macOS
  keychain (`security find-generic-password -w -s <name>`), or an env var
  exported from the login shell (Forest reads `$PATH` from it, not other
  vars, so `source` a file inside the script if the token lives there).
  Never put a token in `settings.json`, the command string, or the repo.
- **Never browser cookies.** Cross-origin fetches can't read them, and
  scraping the browser's cookie store is the hole this design avoids.
- **Validate `$1` first**: `case $1 in *[!A-Za-z0-9#-]*|'') exit 2;; esac`.
  Keys come from branch names and PR titles other people write.
- **Read-only.** One GET or one query; never transition or comment.
- Keep the script in `~/.forest/`, not this repo: it is the user's setup and
  usually names a private host.

## Recipes

Pipe through `jq -e` so a missing ticket (`null`) exits non-zero.

**GitHub issues** (`#45`):

```sh
#!/bin/sh
gh issue view "${1#\#}" --json title,state,assignees \
  --jq '{title, status: .state, assignee: .assignees[0].login}'
```

**Jira Cloud** (API token at id.atlassian.com; Data Center uses
`Authorization: Bearer <PAT>` and `/rest/api/2`):

```sh
#!/bin/sh
token=$(security find-generic-password -w -s jira-api) || exit 1
curl -sf -m 10 -u "you@acme.com:$token" \
  "https://acme.atlassian.net/rest/api/3/issue/$1?fields=summary,status,assignee" |
  jq -e '{title: .fields.summary, status: .fields.status.name,
    category: .fields.status.statusCategory.key, assignee: .fields.assignee.displayName}'
```

**Linear** (personal API key; `issue(id:)` takes the `ENG-123` identifier):

```sh
#!/bin/sh
token=$(security find-generic-password -w -s linear-api) || exit 1
jq -n --arg k "$1" '{query: "query($k:String!){issue(id:$k){title state{name type} assignee{name}}}", variables: {k: $k}}' |
  curl -sf -m 10 https://api.linear.app/graphql -H "Authorization: $token" \
    -H 'Content-Type: application/json' -d @- |
  jq -e '.data.issue | {title, status: .state.name, category: .state.type, assignee: .assignee.name}'
```

**Trackers you can only reach through MCP** (Shipyard and other in-house
tools): read the tracker's MCP client to find how it gets a token (often a
`<tool>-auth token` CLI) and the server URL. A stateless server answers a single
`tools/call` POST: copy the client's headers and protocol version, send
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_task","arguments":{...}}}`,
and unwrap `.result.content[0].text | fromjson` in `jq`. Check `.result.isError`.
A server that needs a session (`initialize` first) is too slow per ticket;
ask whether the tracker has a REST API instead.

## Check it

```sh
~/.forest/my-ticket.sh ROM-123 | jq .        # the object above
~/.forest/my-ticket.sh ROM-0; echo $?        # non-zero
```

Then set `ticketCmds`. A save through the settings API applies at once; a
hand edit of `settings.json` needs a server restart (touch a `.ts` file under
`deno task serve`, which watches). The worktree's
`ticket.info` then shows up in the agent `wts` tool and as a dot in the
ticket column; click the dot's key for the card.
