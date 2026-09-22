import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { stubApi } from './test-support/fakes';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('home page shell', () => {
  it('shows the API as online when /api/health succeeds', async () => {
    stubApi();
    render(
      <MemoryRouter>
        <App client={null} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'GATHER' })).toBeTruthy();
    expect(await screen.findByText('API status: online')).toBeTruthy();
  });

  it('shows the API as offline when the request fails', async () => {
    stubApi({ down: true });
    render(
      <MemoryRouter>
        <App client={null} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('API status: offline')).toBeTruthy();
  });
});
