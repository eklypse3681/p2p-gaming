/** /api/mailbox/status — see `src/mailbox/http.ts`. */
import type { MailboxEnv } from '../../../src/mailbox/http';
import { handleMailbox } from '../../../src/mailbox/http';

export const onRequestGet = ({ request, env }: { request: Request; env: MailboxEnv }) =>
  handleMailbox('status', request, env);
