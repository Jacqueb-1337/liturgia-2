Release 2.1.0

Highlights:
- Add EasyWorship database importer (WASM-based sql.js) to import Songs.db / SongWords.db directly into Liturgia's `songs.json`.
- Added robust RTF stripping and per-song merge (dedupes by title+author).
- Added packaging config to include sql.js WASM for production builds (asar unpack + extraResources).
- Fixed popover initialization crash and improved UI safety.

Testing checklist:
- npm install
- npm start -> File → Import EasyWorship database... should run (or instruct to install sql.js if missing)
- npm run build -> verify the built app includes `sql-wasm.wasm` in resources and importer works on a clean machine.
