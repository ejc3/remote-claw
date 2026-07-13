# Connor's Room — site suite

Three static sites, one per deliverable. Zero build steps — every directory is a
self-contained site with its own landing page (`index.html`).

| Directory | Site | Suggested Vercel project / domain |
|---|---|---|
| `connor-room-board/` | The design board + the narrated film | `connor-room-board.vercel.app` |
| `connor-room-3d/` | Interactive 3D walkthrough (three.js, single file) | `connor-room-3d.vercel.app` |
| `connor-room-palette/` | Witch Hat Atelier paint board | `connor-room-palette.vercel.app` |

## Deploy: one Vercel project per site (monorepo style)

For each of the three directories:

1. vercel.com → **Add New → Project** → import this repo (`ejc3/remote-claw`)
2. **Root Directory** → pick `sites/connor-room-board` (or `-3d` / `-palette`)
3. Framework preset **Other**, no build command, output = root
4. Set the **Production Branch** to the branch that contains `sites/` (or merge it to your default branch first)
5. Deploy → each project gets its own `*.vercel.app` domain; add custom domains in the project's Domains tab

The three landing pages cross-link using the suggested `*.vercel.app` names — if you
pick different project names, update the URLs in each `index.html` (one `U_BOARD`/`U_3D`/`U_PAL`-style
link block near the bottom of each file).
