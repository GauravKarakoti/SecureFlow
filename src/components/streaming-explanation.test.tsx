/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import StreamingExplanation from './streaming-explanation';
import * as hooks from '@/hooks/use-streaming-explanation';

const baseMock = {
  stop: vi.fn(),
  remediationSuggestions: null,
  promptInjectionSuspected: false,
};

describe('StreamingExplanation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders stored explanation initially', () => {
    vi.spyOn(hooks, 'useStreamingExplanation').mockReturnValue({
      ...baseMock,
      isStreaming: false,
      explanation: '',
      remediationSuggestions: null,
      promptInjectionSuspected: false,
      error: null,
      start: vi.fn(),
      stop: vi.fn(),
    });

    render(<StreamingExplanation findingId="123" storedExplanation="Initial stored text." />);

    expect(screen.getByText(/\"Initial stored text.\"/)).toBeInTheDocument();
  });

  it('calls start when Live Analysis button is clicked', () => {
    const startMock = vi.fn();
    vi.spyOn(hooks, 'useStreamingExplanation').mockReturnValue({
      ...baseMock,
      isStreaming: false,
      explanation: '',
      remediationSuggestions: null,
      promptInjectionSuspected: false,
      error: null,
      start: startMock,
      stop: vi.fn(),
    });

    render(<StreamingExplanation findingId="123" storedExplanation="Stored" />);

    const button = screen.getByRole('button', { name: /Live analysis/i });
    fireEvent.click(button);

    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('displays streaming explanation when streaming', () => {
    vi.spyOn(hooks, 'useStreamingExplanation').mockReturnValue({
      ...baseMock,
      isStreaming: true,
      explanation: 'Streamed part',
      remediationSuggestions: null,
      promptInjectionSuspected: false,
      error: null,
      start: vi.fn(),
      stop: vi.fn(),
    });

    render(<StreamingExplanation findingId="123" storedExplanation="Stored" />);

    expect(screen.getByText(/\"Streamed part\"/)).toBeInTheDocument();

    const button = screen.getByRole('button', { name: /Receiving transmission.../i });
    expect(button).toBeDisabled();
  });

  it('displays error and retry button if transmission fails', () => {
    const startMock = vi.fn();
    vi.spyOn(hooks, 'useStreamingExplanation').mockReturnValue({
      ...baseMock,
      isStreaming: false,
      explanation: 'Partial stream',
      remediationSuggestions: null,
      promptInjectionSuspected: false,
      error: 'Network Error',
      start: startMock,
      stop: vi.fn(),
    });

    render(<StreamingExplanation findingId="123" storedExplanation="Stored" />);

    expect(screen.getByText(/Transmission failed: Network Error/)).toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: /Retry Explanation/i });
    fireEvent.click(retryButton);

    expect(startMock).toHaveBeenCalledTimes(1);
  });
});
