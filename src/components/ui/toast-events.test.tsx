/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeistTransmission } from '@/app/share/heist/heist-transmission';
import FindingTriageControls from '@/app/dashboard/findings/finding-triage-controls';

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

const { mockToast } = vi.hoisted(() => ({
  mockToast: vi.fn(),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
    toasts: [],
    dismiss: vi.fn(),
  }),
  toast: mockToast,
}));

vi.mock('@/lib/actions/triage', () => ({
  setFindingStatus: vi.fn().mockResolvedValue({ ok: true }),
}));

describe('Toast Events Integration (#176)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggers toast on skip decryption in HeistTransmission', () => {
    render(
      <HeistTransmission
        projectName="Royal Mint"
        score={100}
        rank="S"
        tagline="Vault secured"
        imageUrl="/api/og/heist"
      />
    );

    const skipButton = screen.getByRole('button', { name: />> skip decryption/i });
    expect(skipButton).toBeInTheDocument();

    fireEvent.click(skipButton);

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'DECRYPTION SKIPPED',
        variant: 'default',
      })
    );
  });

  it('triggers toast on BELLA CIAO keyboard Easter Egg input', () => {
    render(
      <HeistTransmission
        projectName="Royal Mint"
        score={100}
        rank="S"
        tagline="Vault secured"
        imageUrl="/api/og/heist"
      />
    );

    const keys = 'BELLA CIAO'.split('');
    for (const key of keys) {
      fireEvent.keyDown(window, { key });
    }

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'BELLA CIAO ACTIVATED 🎭',
        variant: 'success',
      })
    );
  });

  it('triggers toast on saving triage status', async () => {
    render(
      <FindingTriageControls
        repositoryId="repo-1"
        fingerprint="fp-1"
        currentStatus="OPEN"
        currentNote={null}
      />
    );

    const textarea = screen.getByPlaceholderText(/optional note/i);
    fireEvent.change(textarea, { target: { value: 'Verified false positive' } });

    const button = screen.getByRole('button', { name: /save/i });
    expect(button).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockToast).toHaveBeenCalled();
  });
});
