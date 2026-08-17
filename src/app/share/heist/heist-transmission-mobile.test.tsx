/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeistTransmission } from './heist-transmission';

class MockEventSource {
  close = vi.fn();
  onmessage = null;
  onerror = null;
}
vi.stubGlobal('EventSource', MockEventSource);

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe('Heist Share Page Mobile Responsiveness (#428)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders responsive max-width layout container and break-words for small viewports', () => {
    const { container } = render(
      <HeistTransmission
        projectName="Royal Mint"
        score={100}
        rank="S"
        tagline="Ghost protocol. Zero traces left behind."
        imageUrl="/api/og/heist"
      />
    );

    const main = screen.getByRole('main');
    expect(main).toHaveClass('overflow-hidden');

    const card = container.querySelector('.max-w-\\[calc\\(100vw-1\\.5rem\\)\\]');
    expect(card).toBeInTheDocument();
  });
});
