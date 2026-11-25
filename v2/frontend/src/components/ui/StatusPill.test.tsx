import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill } from './StatusPill';

describe('StatusPill', () => {
  it('affiche un libellé visible, pas seulement une couleur', () => {
    render(<StatusPill state="down" />);
    expect(screen.getByText('Hors service')).toBeInTheDocument();
  });

  it('icône seule : libellé accessible', () => {
    render(<StatusPill state="not_monitored" iconOnly />);
    expect(screen.getByRole('img', { name: 'Non supervisé' })).toBeInTheDocument();
  });

  it('état inattendu : Inconnu', () => {
    render(<StatusPill state={'bizarre'} />);
    expect(screen.getByText('Inconnu')).toBeInTheDocument();
  });
});
