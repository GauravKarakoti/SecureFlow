/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUseStreamingExplanation = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-streaming-explanation', () => ({
  useStreamingExplanation: mockUseStreamingExplanation,
}));

import StreamingExplanation from './streaming-explanation';

const baseMock = {
  stop: vi.fn(),
  retry: vi.fn(),
  remediationSuggestions: null,
  promptInjectionSuspected: false,
  isError: false,
};

describe('StreamingExplanation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders stored explanation initially', () => {
    mockUseStreamingExplanation.mockReturnValue({
      ...baseMock,
      isStreaming: false,
      explanation: '',
      error: null,
      start: vi.fn(),
    });

    render(<StreamingExplanation findingId="123" storedExplanation="Initial stored text." />);

    expect(screen.getByText(/\"Initial stored text.\"/)).toBeInTheDocument();
  });

  it('calls start when Live Analysis button is clicked', () => {
    const startMock = vi.fn();
    mockUseStreamingExplanation.mockReturnValue({
      ...baseMock,
      isStreaming: false,
      explanation: '',
      error: null,
      start: startMock,
    });

    render(<StreamingExplanation findingId="123" storedExplanation="Stored" />);

    fireEvent.click(screen.getByRole('button', { name: /Live analysis/i }));

    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('displays streaming explanation when streaming', () => {
    mockUseStreamingExplanation.mockReturnValue({
      ...baseMock,
      isStreaming: true,
      explanation: 'Streamed part',
      error: null,
      start: vi.fn(),
    });

    render(<StreamingExplanation findingId="123" storedExplanation="Stored" />);

    expect(screen.getByText(/\"Streamed part\"/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Receiving transmission.../i })).toBeDisabled();
  });

  it('displays error and retry button if transmission fails', () => {
    const retryMock = vi.fn();
    mockUseStreamingExplanation.mockReturnValue({
      ...baseMock,
      isStreaming: false,
      explanation: 'Partial stream',
      error: 'Network Error',
      isError: true,
      start: vi.fn(),
      retry: retryMock,
    });

    render(<StreamingExplanation findingId="123" storedExplanation="Stored" />);

    expect(screen.getByText(/Transmission failed: Network Error/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Retry Explanation/i }));

    expect(retryMock).toHaveBeenCalledTimes(1);
  });
});
