/** The commit this build came from (vite.config.ts), or "dev" on the dev server and in tests. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' && import.meta.env.PROD ? __APP_VERSION__ : 'dev';
