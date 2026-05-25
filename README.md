# pokeguess-assets

Derivative visual assets for [PokeGuess](https://github.com/Armytille/PokeDexQuest), an unofficial fan app.

## What this repo contains

- `unown-glow/A.png` … `Z.png` — stylized purple neon halos generated from the silhouette (alpha channel only) of the Pokémon HOME Unown sprites. The original sprite's RGB channels are discarded; what remains is a 3-pass blur (radius 8/4/2) of a recolored silhouette on a transparent canvas.

These are **derivative works** produced by the build script at [`scripts/generate-unown-glow.js`](https://github.com/Armytille/PokeDexQuest/blob/main/scripts/generate-unown-glow.js) in the main app repo. The PokeGuess client fetches them at runtime via [jsDelivr](https://cdn.jsdelivr.net/gh/Armytille/pokeguess-assets@main/unown-glow/A.png) so they don't ship inside the mobile app binary.

## Legal

PokeGuess is an unofficial fan project. It is **not** affiliated with, endorsed by, or connected to Nintendo, Game Freak, or The Pokémon Company. Pokémon and all related names, characters, and indicia are trademarks of Nintendo / Creatures Inc. / GAME FREAK inc.

The source Unown sprites used as silhouette input come from the [PokeAPI/sprites](https://github.com/PokeAPI/sprites) community archive (sprites are sourced from the games and remain the intellectual property of the trademark holders above). The transformations applied here (alpha-only extraction, recoloring, blur stack, composition) are original work; the underlying silhouette shape is not.

Use at your own risk. No warranty.
