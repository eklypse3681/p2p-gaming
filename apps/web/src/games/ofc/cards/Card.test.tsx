import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parseCard } from '@bgf/ofc-engine';
import { Card, HiddenStack, cardLabel, suitColor } from './Card';

describe('Card', () => {
  it('renders a face-up card with its key, label and colour', () => {
    render(<Card card={parseCard('Td')} />);
    const el = screen.getByTestId('card-Td');
    expect(el).toHaveAttribute('data-card', 'Td');
    expect(el).toHaveAttribute('aria-label', '10 of diamonds');
    expect(el.querySelector('text')?.textContent).toBe('T');
    expect(cardLabel(parseCard('As'))).toBe('ace of spades');
    expect(suitColor('h', false)).toContain('red');
    expect(suitColor('c', false)).toContain('black');
    expect(suitColor('c', true)).toContain('clubs');
  });

  it('renders a back and a counted hidden stack', () => {
    render(
      <div>
        <Card faceDown />
        <HiddenStack count={7} testId="stack" />
      </div>,
    );
    expect(screen.getAllByTestId('card-back').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('stack')).toHaveAttribute('data-count', '7');
    expect(screen.getByTestId('stack')).toHaveTextContent('7');
  });
});
