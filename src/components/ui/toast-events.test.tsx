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

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

describe('Toast Events Integration (#176)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default EventSource stub after clearAllMocks wipes mock implementations
    vi.stubGlobal('EventSource', MockEventSource);
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

    // Subsequent keystrokes should not re-trigger the Easter Egg toast repeatedly
    mockToast.mockClear();
    fireEvent.keyDown(window, { key: 'X' });
    fireEvent.keyDown(window, { key: 'Y' });
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('triggers police intercept toast at most once when stream emits thematic keywords', async () => {
    class CapturingEventSource {
      close = vi.fn();
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { CapturingEventSource.last = this; }
      static last: CapturingEventSource | null = null;
    }
    vi.stubGlobal('EventSource', CapturingEventSource);

    render(
      <HeistTransmission
        projectName="Royal Mint"
        score={100}
        rank="S"
        tagline="Vault secured"
        imageUrl="/api/og/heist"
      />
    );

    expect(CapturingEventSource.last).not.toBeNull();

    // Emit chunk containing thematic keyword PROFESSOR
    await act(async () => {
      CapturingEventSource.last!.onmessage!({
        data: JSON.stringify({ type: 'chunk', text: '> SENDER: THE PROFESSOR' }),
      });
    });

    const interceptCalls = mockToast.mock.calls.filter(([args]) =>
      args?.title?.includes('POLICE INTERCEPT')
    );
    expect(interceptCalls).toHaveLength(1);

    // Emit another chunk containing VAULT
    await act(async () => {
      CapturingEventSource.last!.onmessage!({
        data: JSON.stringify({ type: 'chunk', text: 'The vault is secured.' }),
      });
    });

    // Should still only have fired once to prevent toast wild spam
    const interceptCallsAfterSecond = mockToast.mock.calls.filter(([args]) =>
      args?.title?.includes('POLICE INTERCEPT')
    );
    expect(interceptCallsAfterSecond).toHaveLength(1);
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