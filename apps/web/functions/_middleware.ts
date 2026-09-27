/**
 * Cloudflare Pages Function in front of every request. One canonical origin matters here beyond
 * tidiness: per-player storage, and later passkeys, belong to an origin, so a player who arrived
 * on www and one who arrived on the bare domain would otherwise be two different browsers' worth
 * of state.
 */
export const onRequest: PagesFunction = async ({ request, next }) => {
  const url = new URL(request.url);
  if (url.hostname === 'www.amongfriends.gg') {
    url.hostname = 'amongfriends.gg';
    return Response.redirect(url.toString(), 301);
  }
  return next();
};

interface PagesFunction {
  (context: { request: Request; next: () => Promise<Response> }): Promise<Response>;
}
