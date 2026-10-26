# Capabilities — things the agent can do that it will forget

This file is loaded into the L1 hot memory block every session. Add capabilities here as
they are built. Remove them when decommissioned. One line per capability.

Keep each line short enough to be read at a glance and specific enough to act on: what it
is, how it is reached, and the one gotcha that bites.

## Format

```
- <capability> — <how it is invoked> (<the gotcha, if any>)
```

<!--
This file ships EMPTY of real entries on purpose (#30). It previously shipped seven
example lines describing one particular person's house — smart speaker output, home
automation, apartment sensors — and because this file is injected into the hot block
verbatim, anyone who cloned the repo carried a stranger's house in their agent's memory
until they noticed. An example that reads as fact is worse than no example.
-->
