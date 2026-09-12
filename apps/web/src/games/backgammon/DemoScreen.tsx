import { BoardDemo } from '../../board/BoardDemo';

export function DemoScreen() {
  return (
    <div className="page" data-testid="demo-screen">
      <div className="stack">
        <div>
          <div className="eyebrow">Renderer demo</div>
          <h1>Board playground</h1>
          <p className="muted">
            A fixed mid-game position for trying themes and perspectives without a match.
          </p>
        </div>
        <BoardDemo />
      </div>
    </div>
  );
}
