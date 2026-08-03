/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CyberAvatarReveal } from './cyber-avatar-reveal';

describe('CyberAvatarReveal', () => {
  it('renders fallback icon when no image is provided', () => {
    render(<CyberAvatarReveal />);
    const container = screen.getByRole('img', { name: 'Profile — identity masked' });
    expect(container).toBeInTheDocument();
    
    // Default state: not revealing
    expect(container.className).not.toContain('cyber-icon-glitch');
  });

  it('triggers glitch animation on hover when no image is provided', () => {
    render(<CyberAvatarReveal />);
    const container = screen.getByRole('img', { name: 'Profile — identity masked' });
    
    fireEvent.mouseEnter(container);
    expect(container.className).toContain('cyber-icon-glitch');
    
    fireEvent.mouseLeave(container);
    expect(container.className).not.toContain('cyber-icon-glitch');
  });

  it('renders primary avatar glitch swap when image is provided', () => {
    render(<CyberAvatarReveal image="/avatar.png" name="Test User" />);
    const container = screen.getByLabelText('Test User', { selector: 'div' });
    expect(container).toBeInTheDocument();
    
    // Since phases are managed internally, we can check for classes in children
    // The mask layer should be present and visible initially
    // Since we don't have good queries for internals easily, we can check by the avatar image
    const img = screen.getByAltText('Test User');
    expect(img).toBeInTheDocument();
  });

  it('transitions state correctly on mouse enter and leave with image', () => {
    render(<CyberAvatarReveal image="/avatar.png" name="Test User" />);
    const container = screen.getByLabelText('Test User', { selector: 'div' });
    
    // We can observe the wrapper getting the shadow when hovered
    expect(container.className).not.toContain('shadow-[');
    
    fireEvent.mouseEnter(container);
    expect(container.className).toContain('shadow-[');
    
    // When mouse leaves, the class might still be present if it's 'concealing' instead of 'idle'
    // but the shadow is tied to phase !== 'idle', so concealing keeps the shadow until animation ends.
    fireEvent.mouseLeave(container);
    expect(container.className).toContain('shadow-[');
  });
});
