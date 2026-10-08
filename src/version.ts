/**
 * The release shown in the Esc menu. The version is package.json "version", bumped by hand for a
 * release (docs/DEPLOY.md); the build is the short commit vite.config.ts embeds, or "dev".
 */
declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

export const VERSION_LABEL = `Alpha v${__APP_VERSION__} · build ${__BUILD_HASH__}`;
