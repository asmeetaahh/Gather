import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { charity, stubApi } from './test-support/fakes';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('home page (PRD §12 UX-04: what the user does, how they win, charity impact, the CTA)', () => {
  it('leads with the hero, the core loop, the prize tiers and both calls to action', () => {
    stubApi();
    render(
      <MemoryRouter>
        <App client={null} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'GATHER' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveProperty(
      'href',
      expect.stringContaining('/signup'),
    );
    expect(screen.getByRole('link', { name: 'View charities' })).toHaveProperty(
      'href',
      expect.stringContaining('/charities'),
    );

    expect(screen.getByRole('heading', { name: 'How Gather works' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Enter your scores' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Win a prize' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Give back' })).toBeTruthy();

    expect(screen.getByRole('heading', { name: 'Three ways to win' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '5-number match' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '4-number match' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '3-number match' })).toBeTruthy();
    // No invented prize-pool percentage or jackpot figure.
    expect(screen.queryByText(/%\s*of the (prize )?pool/i)).toBeNull();

    expect(screen.getByRole('heading', { name: 'Your subscription gives back' })).toBeTruthy();
    expect(screen.getByText(/At least 10% of every payment/)).toBeTruthy();

    expect(screen.getByRole('heading', { name: 'Ready to play for good?' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign up now' })).toBeTruthy();
  });

  it('shows the featured charity spotlight when one exists', async () => {
    stubApi({ charities: [charity(1, { isFeatured: true })] });
    render(
      <MemoryRouter>
        <App client={null} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Charity spotlight' })).toBeTruthy();
    expect(await screen.findByText('Charity 1')).toBeTruthy();
  });

  it('never fabricates a spotlight when nothing is featured (honest empty state)', () => {
    stubApi({ charities: [] });
    render(
      <MemoryRouter>
        <App client={null} />
      </MemoryRouter>,
    );
    // The rest of the homepage still renders; only the spotlight section is honestly absent.
    expect(screen.getByRole('heading', { name: 'GATHER' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Charity spotlight' })).toBeNull();
  });
});
