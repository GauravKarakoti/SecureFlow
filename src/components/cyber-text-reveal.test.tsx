/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CyberTextReveal } from './cyber-text-reveal';

vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  return setTimeout(() => cb(performance.now()), 16);
});
vi.stubGlobal('cancelAnimationFrame', (id: number) => {
  clearTimeout(id);
});

describe('CyberTextReveal', () => {
  it('renders codename by default in hover mode', () => {
    render(<CyberTextReveal codename="Ghost" realName="John Doe" />);
    // The screen reader text is always the target name
    const srText = screen.getByText('John Doe');
    expect(srText).toHaveClass('sr-only');
    
    // The visible scrambled text starts as the codename
    const visibleContainer = screen.getByText('Ghost', { selector: '[aria-hidden="true"]' });
    expect(visibleContainer).toBeInTheDocument();
  });

  it('changes state on hover in hover mode', () => {
    render(<CyberTextReveal codename="Ghost" realName="John Doe" duration={0} />);
    const visibleContainer = screen.getByText('Ghost', { selector: '[aria-hidden="true"]' });
    
    act(() => {
      fireEvent.mouseEnter(visibleContainer);
    });
    
    // With duration=0, the scramble text should immediately become the real name
    expect(visibleContainer).toHaveTextContent('John Doe');
    
    act(() => {
      fireEvent.mouseLeave(visibleContainer);
    });
    
    expect(visibleContainer).toHaveTextContent('Ghost');
  });

  it('auto-decodes in transmission mode', async () => {
    const onComplete = vi.fn();
    
    render(
      <CyberTextReveal 
        variant="transmission" 
        text="Decoded Secret" 
        delay={10} 
        duration={50}
        onRevealComplete={onComplete}
      />
    );
    
    const srText = screen.getByText('Decoded Secret');
    expect(srText).toHaveClass('sr-only');

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    }, { timeout: 1000 });
  });
});
