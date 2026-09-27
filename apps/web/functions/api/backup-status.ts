/** GET /api/backup-status — whether passkey backups can be stored here yet. */
interface Context {
  env: { BACKUPS?: unknown };
}

export const onRequestGet = async ({ env }: Context): Promise<Response> =>
  new Response(JSON.stringify({ passkeys: !!env.BACKUPS }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  });
