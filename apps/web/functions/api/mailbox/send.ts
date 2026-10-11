/** /api/mailbox/send — see `src/mailbox/http.ts`. */
import type { MailboxEnv } from '../../../src/mailbox/http';
import { handleMailbox } from '../../../src/mailbox/http';

export const onRequestPost = ({ request, env }: { request: Request; env: MailboxEnv }) =>
  handleMailbox('send', request, env);
