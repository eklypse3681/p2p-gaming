import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ClientState, GameClientApi } from '@bgf/client';
import { playerName } from './derive';
import { formatTime } from '../session/time';
import styles from './Chat.module.css';

export function Chat({
  state,
  client,
}: {
  state: ClientState;
  client: Pick<GameClientApi, 'sendChat'>;
}) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.chat.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    client.sendChat(t.slice(0, 500));
    setText('');
  };

  return (
    <div className={styles.chat} data-testid="chat">
      <div className={styles.list} ref={listRef} data-testid="chat-list">
        {state.chat.length === 0 && <div className={styles.empty}>Say hello 👋</div>}
        {state.chat.map((m, i) => (
          <div
            key={`${m.at}-${i}`}
            className={`${styles.msg} ${m.seat === state.seat ? styles.mine : ''}`}
            data-testid="chat-message"
          >
            <span className={styles.who}>
              {m.seat === state.seat ? 'You' : playerName(state, m.seat)} · {formatTime(m.at)}
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
          disabled={state.status !== 'joined'}
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
