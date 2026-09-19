import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TableChat as TableChatMessage } from '@bgf/protocol';
import { formatTime } from '../../../session/time';
import styles from '../../../hud/Chat.module.css';

/** Chat for a table of N seats (the backgammon `Chat` is keyed by colour). */
export function TableChat({
  chat,
  mySeat,
  names,
  dealerName,
  disabled,
  onSend,
}: {
  chat: TableChatMessage[];
  mySeat: number | null;
  names: string[];
  /** Name shown for messages from the dealer (seat −1). */
  dealerName?: string;
  disabled?: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t.slice(0, 500));
    setText('');
  };

  return (
    <div className={styles.chat} data-testid="chat">
      <div className={styles.list} ref={listRef} data-testid="chat-list">
        {chat.length === 0 && <div className={styles.empty}>Say hello 👋</div>}
        {chat.map((m, i) => (
          <div
            key={`${m.at}-${i}`}
            className={`${styles.msg} ${m.seat === mySeat ? styles.mine : ''}`}
            data-testid="chat-message"
          >
            <span className={styles.who}>
              {m.seat === mySeat
                ? 'You'
                : m.seat < 0
                  ? `${dealerName ?? 'Dealer'} (dealer)`
                  : (names[m.seat] ?? `Seat ${m.seat + 1}`)}{' '}
              · {formatTime(m.at)}
            </span>
            {m.text}
          </div>
        ))}
      </div>
      <form className={styles.form} onSubmit={submit}>
        <input
          className="input"
          data-testid="chat-input"
          placeholder="Message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
          maxLength={500}
          aria-label="Chat message"
        />
        <button className="btn" type="submit" data-testid="chat-send" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
