/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CyberRainBackground } from './cyber-rain-background';

describe('CyberRainBackground (#405)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders canvas element with default props and receives isTyping and tokensPerSecond', () => {
    const { container } = render(
      <CyberRainBackground
        opacity={0.13}
        theme="heist"
        speedMultiplier={2.5}
        isTyping={true}
        tokensPerSecond={45}
      />
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveStyle({ opacity: '0.13' });
  });

  it('handles idle state with isTyping=false and tokensPerSecond=0', () => {
    const { container } = render(
      <CyberRainBackground
        opacity={0.13}
        theme="heist"
        speedMultiplier={1.0}
        isTyping={false}
        tokensPerSecond={0}
      />
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });
});
