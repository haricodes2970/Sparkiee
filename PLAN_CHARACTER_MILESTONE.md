# Character Animation, Voice & Subtitle Milestone — working checklist

Decisions:
- Asset research done: no legally clean Pikachu-style sheet found (derivative
  works regardless of uploader's CC0 claim). Freesound lead
  (silasonlyW "pikachu pokemon") REJECTED: character voice is Nintendo/Game
  Freak IP, uploader cannot relicense. → Original character + original
  synthesized voice per spec fallback.
- Character: original golden electric blob "Sparkiee" (curled teal tuft,
  swirl tail, amber cheeks — deliberately not Pikachu silhouette).

Steps (small commits):
1. [ ] `feat: add character pack manifest and asset attribution`
   - docs/ASSET_CREDITS.md (inventory incl. rejected candidates)
   - assets/characters/sparkiee-original/manifest.json
   - scripts/generate-sprites.mjs (pure-node PNG encoder, procedural frames)
   - generated sprites/sheet.png
   - core/character-pack.mjs: validateCharacterPackManifest, listCharacterPacks,
     safeResolveAssetPath (escape-proof)
   - tests for validation + path escape
2. [ ] `feat: implement expressive character sprite animations`
   - renderer frame player (image-rendering: pixelated, per-frame timing)
   - pet-host main: load manifest, resize window to layout
   - reactToMovement covers new states (no roam during dance/sleep/celebrate/etc.)
3. [ ] `feat: add voice reactions and audio settings`
   - renderer/lib/audio-engine.mjs (Web Audio synth chirps, priority queue,
     cooldowns, mute/volume, missing-file fallback, cleanup)
   - pet-state settings: audio {enabled, volume}, characterId
   - server: extended settings validation, POST /api/v1/pet/test-sound,
     GET /api/v1/characters + /api/v1/character
4. [ ] `feat: render synced subtitles beneath desktop pet`
   - layout: sprite → name → caption beneath; window taller; caption
     animation, duration, large-caption a11y setting; pointer-events safe
5. [ ] `feat: add dashboard character and audio controls`
   - character & audio section: pack info, animation/emotion/caption state,
     audio toggle, volume, test sound, captions toggle, duration, large
6. [ ] `test: cover character animation and audio behaviour`
   - audio engine queue/cooldown/mute tests (fake AudioContext), voice map,
     caption settings, malformed/missing assets, integration regression
7. [ ] `docs: document character packs and audio licensing`
   - README/STATUS/PHASE doc updates + Fedora live verification results

Live Fedora verification at the end: caption beneath sprite (screenshot),
movement/drag/hide/show regression, test-sound via dashboard endpoint.
