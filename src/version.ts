/**
 * The release shown in the Esc menu. The version is package.json "version", bumped by hand for a
 * release (docs/DEPLOY.md); the build is the short commit vite.config.ts embeds, or "dev".
 */
declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

/** Short commit of this build, or "dev"; also versions the physics Wasm URL so a deploy never pairs new JS with an old binary. */
export const BUILD_HASH = __BUILD_HASH__;

export const VERSION_LABEL = `Alpha v${__APP_VERSION__} · build ${BUILD_HASH}`;
