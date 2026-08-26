/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PolicyCard } from './policy-card';

const mockToast = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function renderCard(overrides: Record<string, unknown> = {}) {
  const toggleAction = vi.fn(async (_input: unknown) => ({ ok: true, isActive: true }));

  const props = {
    id: 'tpl-1',
    title: 'Block Hardcoded Secrets',
    description: 'Blocks a PR carrying a hardcoded credential.',
    isActive: false,
    severity: 'CRITICAL',
    action: 'DENY',
    rules: ['secrets/*'],
    toggleAction,
    ...overrides,
  };

  render(<PolicyCard {...props} />);
  return { toggleAction, props };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PolicyCard toggle (#660)', () => {
  it('sends the state the user asked for, not the previous one', async () => {
    const { toggleAction } = renderCard({ isActive: false });

    await userEvent.click(screen.getByRole('switch'));

    await waitFor(() =>
      expect(toggleAction).toHaveBeenCalledWith({ templateId: 'tpl-1', isActive: true })
    );
  });

  it('sends false when switching a rule off', async () => {
    const { toggleAction } = renderCard({ isActive: true });

    await userEvent.click(screen.getByRole('switch'));

    await waitFor(() =>
      expect(toggleAction).toHaveBeenCalledWith({ templateId: 'tpl-1', isActive: false })
    );
  });

  it('never sends the old currentState field', async () => {
    const { toggleAction } = renderCard({ isActive: false });

    await userEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(toggleAction).toHaveBeenCalled());
    const payload = toggleAction.mock.calls[0][0] as Record<string, unknown>;

    expect(payload).not.toHaveProperty('currentState');
    expect(payload).not.toBeInstanceOf(FormData);
  });

  it('tells the user when the change did not save', async () => {
    const toggleAction = vi.fn(async (_input: unknown) => ({
      ok: false,
      error: 'Your session has expired. Sign in again to change rules.',
    }));
    render(
      <PolicyCard
        id="tpl-1"
        title="Block Hardcoded Secrets"
        description="d"
        isActive={false}
        severity="CRITICAL"
        action="DENY"
        rules={[]}
        toggleAction={toggleAction}
      />
    );

    await userEvent.click(screen.getByRole('switch'));

    // An expired session used to be indistinguishable from success: the action
    // returned undefined either way and the switch stayed flipped.
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          title: 'Rule not updated',
          description: 'Your session has expired. Sign in again to change rules.',
        })
      )
    );
  });

  it('stays quiet when the change saved', async () => {
    renderCard({ isActive: false });

    await userEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(mockToast).not.toHaveBeenCalled());
  });

  it('falls back to a generic message when the action returns nothing', async () => {
    const toggleAction = vi.fn(async (_input: unknown) => undefined);
    render(
      <PolicyCard
        id="tpl-1"
        title="t"
        description="d"
        isActive={false}
        severity="LOW"
        action="REVIEW"
        rules={[]}
        toggleAction={toggleAction}
      />
    );

    await userEvent.click(screen.getByRole('switch'));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive' })
      )
    );
  });

  it('reflects the stored state on first render', () => {
    renderCard({ isActive: true });

    expect(screen.getByRole('switch')).toBeChecked();
  });
});
