import { utf8Bytes } from '@bgf/protocol';

/** What a device signs to register: binds the token to the player and device, with the time. */
export function registrationBytes(r: {
  player: string;
  device: string;
  at: number;
  token: string;
}): Uint8Array {
  return utf8Bytes(`amongfriends mailbox\n${r.player}\n${r.device}\n${r.at}\n${r.token}`);
}
